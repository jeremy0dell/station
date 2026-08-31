import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StationConfig, stationHostSocketPath } from "@station/config";
import type * as HostContracts from "@station/contracts";
import type { HostHandoffFidelity, StationHostTargetBuild } from "@station/contracts";
import type { classifyHostCompatibility } from "@station/host";
import { stationBuildInfo } from "@station/runtime";
import { convergeStationHost, inspectStationHost } from "@station/terminal";
import { resolveObserverPaths } from "../../paths.js";
import { selfExecArgv } from "../../selfExec.js";
import { parseHostArgs } from "./args.js";

export type HostCommandDeps = {
  convergeHost?: typeof convergeStationHost;
  inspectHost?: typeof inspectStationHost;
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

export type HostHandoffResult = {
  action: "handoff";
  dryRun: boolean;
  fidelity: HostHandoffFidelity;
  socketPath: string;
  status: "planned" | "completed" | "refused" | "unavailable";
  message: string;
  livePtyCount?: number;
  /** Exact PTY IDs projected from the validated handoff receipt. */
  adopted?: string[];
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

export function hostCommandSummary(result: HostCommandResult): string {
  if (result.action === "status") {
    const lines = [`socket: ${result.socketPath}`, `probe: ${result.probe}`];
    if (result.health !== undefined)
      lines.push(
        `health: ok protocol=${result.health.protocolVersion} build=${result.health.buildVersion}`,
      );
    if (result.compatibility !== undefined)
      lines.push(`compatibility: ${result.compatibility.action}`);
    if (result.livePtyCount !== undefined) lines.push(`livePtys: ${result.livePtyCount}`);
    if (result.handoffEligible !== undefined)
      lines.push(`handoffEligible: ${result.handoffEligible}`);
    if (result.error !== undefined) lines.push(`error: ${result.error}`);
    return `${lines.join("\n")}\n`;
  }
  const lines = [
    `handoff: ${result.status}`,
    `fidelity: ${result.fidelity}`,
    `dryRun: ${result.dryRun}`,
    `socket: ${result.socketPath}`,
    result.message,
  ];
  if (result.livePtyCount !== undefined) lines.push(`livePtys: ${result.livePtyCount}`);
  if (result.adopted !== undefined) lines.push(`adopted: ${result.adopted.length}`);
  return `${lines.join("\n")}\n`;
}

function projectStatus(
  socketPath: string,
  targetBuild: StationHostTargetBuild,
  inspection: Awaited<ReturnType<typeof inspectStationHost>>,
): HostStatusResult {
  const base = { action: "status" as const, socketPath };
  if (inspection.status === "absent" || inspection.status === "stale")
    return { ...base, probe: inspection.status, error: "Host socket is not listening." };
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
      : ({ action: "replace", runningBuildVersion: health.buildVersion } as const);
  const targetExact =
    health.buildVersion === targetBuild.buildVersion && buildIdentity === targetBuild.buildIdentity;
  return {
    ...base,
    probe: "listening",
    health,
    compatibility,
    buildIdentity,
    livePtyCount: terminals.length,
    ptys: terminals,
    handoffEligible:
      !targetExact && terminals.length > 0 && terminals.every(handoffTerminalEligible),
  };
}

async function runHostHandoff(
  input: {
    socketPath: string;
    stateDir: string;
    targetBuild: StationHostTargetBuild;
    dryRun: boolean;
    fidelity: HostHandoffFidelity;
    inspection: Awaited<ReturnType<typeof inspectStationHost>>;
  },
  deps: {
    convergeHost: typeof convergeStationHost;
    resolveHostCommand: () => readonly [string, ...string[]];
    now: () => number;
  },
): Promise<HostHandoffResult> {
  const base = {
    action: "handoff" as const,
    dryRun: input.dryRun,
    fidelity: input.fidelity,
    socketPath: input.socketPath,
  };
  if (input.inspection.status !== "exact") {
    if (
      input.inspection.status === "unknown" &&
      input.inspection.reason === "health-failed" &&
      input.inspection.error.code === "HOST_VERSION_INCOMPATIBLE"
    )
      return {
        ...base,
        status: "refused",
        message: "Host protocol is incompatible; live handoff is refused.",
      };
    return {
      ...base,
      status: "unavailable",
      message:
        input.inspection.status === "absent" || input.inspection.status === "stale"
          ? "No incumbent host was available for live handoff."
          : input.inspection.error.message,
    };
  }
  const evidence = input.inspection.evidence;
  if (exactTarget(evidence, input.targetBuild))
    return {
      ...base,
      status: "refused",
      message: "Host already matches this build; handoff is unnecessary.",
    };
  if (evidence.terminals.length > 0 && !evidence.terminals.every(handoffTerminalEligible))
    return {
      ...base,
      status: "refused",
      message: "Host terminals are not all eligible for live handoff.",
      livePtyCount: evidence.terminals.length,
    };
  if (input.dryRun) {
    if (evidence.terminals.length === 0)
      return {
        ...base,
        status: "refused",
        message: "Host is idle; use ordinary stop-if-idle replacement instead of handoff.",
        livePtyCount: 0,
      };
    return {
      ...base,
      status: "planned",
      message: `Would beginHandoff(fidelity=${input.fidelity}) → completeHandoff → spawn successor → adoptRegistry.`,
      livePtyCount: evidence.terminals.length,
    };
  }
  const command =
    evidence.terminals.length === 0
      ? {
          action: "replace-idle" as const,
          targetBuild: input.targetBuild,
          socketPath: input.socketPath,
          expected: evidence,
          deadlineMs: deps.now() + 12_000,
        }
      : {
          action: "handoff" as const,
          targetBuild: input.targetBuild,
          socketPath: input.socketPath,
          expected: evidence,
          deadlineMs: deps.now() + 12_000,
          fidelity: input.fidelity,
        };
  try {
    const result = await deps.convergeHost({
      command,
      targetBuild: input.targetBuild,
      socketPath: input.socketPath,
      stateDir: input.stateDir,
      hostCommand: deps.resolveHostCommand(),
    });
    if (result.status === "failed")
      return { ...base, status: "unavailable", message: result.error.message };
    if (result.action === "replace-idle")
      return {
        ...base,
        status: "refused",
        message: "Host is idle; ordinary stop-if-idle replacement ran instead of handoff.",
        livePtyCount: 0,
      };
    const adopted = result.handoffReceipt.terminals.map(({ ptyId }) => ptyId);
    return {
      ...base,
      status: "completed",
      message: `Live handoff completed; successor adopted ${adopted.length} terminal(s).`,
      livePtyCount: adopted.length,
      adopted,
    };
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function exactTarget(
  evidence: Extract<
    Awaited<ReturnType<typeof inspectStationHost>>,
    { status: "exact" }
  >["evidence"],
  target: StationHostTargetBuild,
): boolean {
  return (
    evidence.health.buildVersion === target.buildVersion &&
    evidence.buildIdentity === target.buildIdentity
  );
}
function handoffTerminalEligible(terminal: HostContracts.StationHostTerminalLifetime): boolean {
  return terminal.alive && terminal.handoffSupport.kind === "bridge-releasable";
}

function resolveStationHostEntry(): string {
  const fromEnv = process.env.STATION_HOST_ENTRY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  return join(repoRoot, "station/src/host/hostMain.ts");
}
function resolveStationHostCommand(): readonly [string, ...string[]] {
  return selfExecArgv("station-host", [
    process.env.STATION_BUN ?? "bun",
    resolveStationHostEntry(),
  ]);
}
