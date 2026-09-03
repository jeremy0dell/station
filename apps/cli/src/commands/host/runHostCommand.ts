import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StationConfig, stationHostSocketPath } from "@station/config";
import type * as HostContracts from "@station/contracts";
import {
  type StationHostTargetBuild,
  stationHostEvidenceMatchesTargetBuild,
  stationHostTerminalsAreHandoffEligible,
} from "@station/contracts";
import type { classifyHostCompatibility } from "@station/host";
import { stationBuildInfo } from "@station/runtime";
import {
  convergeStationHost,
  inspectStationHost,
  type recoverExactStationHostOrphans,
} from "@station/terminal";
import { resolveObserverPaths } from "../../paths.js";
import { selfExecArgv } from "../../selfExec.js";
import { parseHostArgs } from "./args.js";
import { type HostHandoffResult, runHostHandoff } from "./hostHandoff.js";

export type { HostHandoffResult } from "./hostHandoff.js";

export type HostCommandDeps = {
  convergeHost?: typeof convergeStationHost;
  inspectHost?: typeof inspectStationHost;
  recoverHostOrphans?: typeof recoverExactStationHostOrphans;
  resolveHostCommand?: () => readonly [string, ...string[]];
  /** Test/composition override for the requesting Station display build. */
  expectedBuildVersion?: string;
  /** Test/composition override for the requesting immutable build identity. */
  expectedBuildIdentity?: HostContracts.StationBuildIdentity;
  now?: () => number;
};

export type HostStatusResult = {
  action: "status";
  socketPath: string;
  probe: string;
  health?: HostContracts.StationHostInspectedHealth;
  compatibility?: Exclude<ReturnType<typeof classifyHostCompatibility>, { action: "refuse" }>;
  buildIdentity?: HostContracts.StationBuildIdentity;
  livePtyCount?: number;
  ptys?: HostContracts.StationHostTerminalLifetime[];
  handoffEligible?: boolean;
  error?: string;
};

export type HostCommandResult = HostStatusResult | HostHandoffResult;
export type HostCommandOptions = { config: StationConfig };

/**
 * ADAPTER
 *
 * Projects exact inspection and convergence into the stable CLI object and text contract.
 */
export async function runHostCommand(
  args: readonly string[],
  options: HostCommandOptions,
  deps: HostCommandDeps = {},
): Promise<HostCommandResult> {
  const parsed = parseHostArgs(args);
  const socketPath = stationHostSocketPath(options.config);
  const targetBuild = resolveTargetBuild(deps);
  const inspectHost = deps.inspectHost ?? inspectStationHost;
  const inspection = await inspectHost({
    socketPath,
    expectedBuildVersion: targetBuild.buildVersion,
  });
  if (parsed.action === "status") return projectStatus(socketPath, targetBuild, inspection);
  return runHostHandoff(
    {
      socketPath,
      stateDir: resolveObserverPaths(options.config).stateDir,
      targetBuild,
      dryRun: parsed.dryRun,
      fidelity: parsed.fidelity,
      inspection,
    },
    {
      convergeHost: deps.convergeHost ?? convergeStationHost,
      resolveHostCommand: deps.resolveHostCommand ?? resolveStationHostCommand,
      now: deps.now ?? Date.now,
    },
  );
}

function resolveTargetBuild(deps: HostCommandDeps): StationHostTargetBuild {
  if (deps.expectedBuildVersion !== undefined && deps.expectedBuildIdentity !== undefined) {
    return {
      buildVersion: deps.expectedBuildVersion,
      buildIdentity: deps.expectedBuildIdentity,
    };
  }
  const build = stationBuildInfo();
  return {
    buildVersion: deps.expectedBuildVersion ?? build.version,
    buildIdentity: deps.expectedBuildIdentity ?? build.buildIdentity,
  };
}

function projectStatus(
  socketPath: string,
  targetBuild: StationHostTargetBuild,
  inspection: Awaited<ReturnType<typeof inspectStationHost>>,
): HostStatusResult {
  const base = { action: "status" as const, socketPath };
  if (inspection.status === "absent" || inspection.status === "stale")
    return {
      ...base,
      probe: inspection.status,
      error: "Host socket is not listening.",
    };
  if (inspection.status === "inaccessible" || inspection.status === "unknown")
    return {
      ...base,
      probe: inspection.status === "inaccessible" ? "inaccessible" : "listening",
      error: inspection.error.message,
    };
  const { health, buildIdentity, terminals } = inspection.evidence;
  const compatibility =
    health.buildVersion === targetBuild.buildVersion
      ? ({ action: "reuse" } as const)
      : ({
          action: "replace",
          runningBuildVersion: health.buildVersion,
        } as const);
  const targetExact = stationHostEvidenceMatchesTargetBuild(inspection.evidence, targetBuild);
  return {
    ...base,
    probe: "listening",
    health,
    compatibility,
    buildIdentity,
    livePtyCount: terminals.length,
    ptys: terminals,
    handoffEligible: !targetExact && stationHostTerminalsAreHandoffEligible(terminals),
  };
}

function resolveStationHostEntry(): string {
  const fromEnv = process.env.STATION_HOST_ENTRY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  return join(repoRoot, "station/src/host/hostMain.ts");
}
export function resolveStationHostCommand(): readonly [string, ...string[]] {
  return selfExecArgv("station-host", [
    process.env.STATION_BUN ?? "bun",
    resolveStationHostEntry(),
  ]);
}
