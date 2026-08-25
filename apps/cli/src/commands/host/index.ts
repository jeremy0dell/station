import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StationConfig, stationHostSocketPath } from "@station/config";
import type * as HostContracts from "@station/contracts";
import type { HostHandoffFidelity } from "@station/contracts";
import {
  classifyHostCompatibility,
  createStationHostClient,
  type StationHostClient,
} from "@station/host";
import { stationBuildInfo } from "@station/runtime";
import { ensureStationHostRunning, inspectStationHost } from "@station/terminal";
import { resolveObserverPaths } from "../../paths.js";
import { selfExecArgv } from "../../selfExec.js";
import { parseHostArgs } from "./args.js";

export type HostCommandDeps = {
  clientFactory?: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
  ensureHost?: typeof ensureStationHostRunning;
  resolveHostCommand?: () => readonly [string, ...string[]];
  /** Test/composition override for the requesting Station build identity. */
  expectedBuildVersion?: string;
  inspectHost?: typeof inspectStationHost;
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
  /** From ensure's fail-closed adopt report when status is completed. */
  adopted?: string[];
};

export type HostCommandResult = HostStatusResult | HostHandoffResult;

export type HostCommandOptions = {
  config: StationConfig;
};

/**
 * ADAPTER
 *
 * Drive Station host inspection and opt-in live handoff from the CLI without
 * routing through Observer application code. Mutating handoff defers policy to
 * `ensureStationHostRunning`; this layer only projects the ensure outcome.
 */
export async function runHostCommand(
  args: readonly string[],
  options: HostCommandOptions,
  deps: HostCommandDeps = {},
): Promise<HostCommandResult> {
  const parsed = parseHostArgs(args);
  const socketPath = stationHostSocketPath(options.config);
  const stateDir = resolveObserverPaths(options.config).stateDir;
  const expectedBuildVersion = deps.expectedBuildVersion ?? stationBuildInfo().version;
  const clientFactory =
    deps.clientFactory ??
    ((path, build) => createStationHostClient({ socketPath: path, expectedBuildVersion: build }));

  if (parsed.action === "status") {
    return runHostStatus({
      socketPath,
      expectedBuildVersion,
      clientFactory,
      inspectHost: deps.inspectHost ?? inspectStationHost,
    });
  }
  return runHostHandoff({
    socketPath,
    stateDir,
    expectedBuildVersion,
    dryRun: parsed.dryRun,
    fidelity: parsed.fidelity,
    clientFactory,
    ensureHost: deps.ensureHost ?? ensureStationHostRunning,
    resolveHostCommand: deps.resolveHostCommand ?? resolveStationHostCommand,
  });
}

export function hostCommandSummary(result: HostCommandResult): string {
  if (result.action === "status") {
    const lines = [`socket: ${result.socketPath}`, `probe: ${result.probe}`];
    if (result.health !== undefined) {
      lines.push(
        `health: ok protocol=${result.health.protocolVersion} build=${result.health.buildVersion}`,
      );
    }
    if (result.compatibility !== undefined) {
      lines.push(`compatibility: ${result.compatibility.action}`);
    }
    if (result.livePtyCount !== undefined) {
      lines.push(`livePtys: ${result.livePtyCount}`);
    }
    if (result.handoffEligible !== undefined) {
      lines.push(`handoffEligible: ${result.handoffEligible}`);
    }
    if (result.error !== undefined) {
      lines.push(`error: ${result.error}`);
    }
    return `${lines.join("\n")}\n`;
  }

  const lines = [
    `handoff: ${result.status}`,
    `fidelity: ${result.fidelity}`,
    `dryRun: ${result.dryRun}`,
    `socket: ${result.socketPath}`,
    result.message,
  ];
  if (result.livePtyCount !== undefined) {
    lines.push(`livePtys: ${result.livePtyCount}`);
  }
  if (result.adopted !== undefined) {
    lines.push(`adopted: ${result.adopted.length}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Projects private exact inspection into the existing read-only Host status shape. */
async function runHostStatus(input: {
  socketPath: string;
  expectedBuildVersion: string;
  clientFactory: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
  inspectHost: typeof inspectStationHost;
}): Promise<HostStatusResult> {
  const inspection = await input.inspectHost(
    { socketPath: input.socketPath, expectedBuildVersion: input.expectedBuildVersion },
    { clientFactory: input.clientFactory },
  );
  const base = { action: "status" as const, socketPath: input.socketPath };
  if (inspection.status === "absent" || inspection.status === "stale") {
    return { ...base, probe: inspection.status, error: "Host socket is not listening." };
  }
  if (inspection.status === "inaccessible" || inspection.status === "unknown") {
    const probe = inspection.status === "inaccessible" ? "inaccessible" : "listening";
    return { ...base, probe, error: inspection.error.message };
  }
  const { health, buildIdentity, terminals } = inspection.evidence;
  const compatibility =
    health.buildVersion === input.expectedBuildVersion
      ? ({ action: "reuse" } as const)
      : ({ action: "replace", runningBuildVersion: health.buildVersion } as const);
  return {
    ...base,
    probe: "listening",
    health,
    compatibility,
    buildIdentity,
    livePtyCount: terminals.length,
    ptys: terminals,
    handoffEligible: compatibility.action === "replace" && terminals.length > 0,
  };
}

async function runHostHandoff(input: {
  socketPath: string;
  stateDir: string;
  expectedBuildVersion: string;
  dryRun: boolean;
  fidelity: HostHandoffFidelity;
  clientFactory: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
  ensureHost: typeof ensureStationHostRunning;
  resolveHostCommand: () => readonly [string, ...string[]];
}): Promise<HostHandoffResult> {
  const base = {
    action: "handoff" as const,
    dryRun: input.dryRun,
    fidelity: input.fidelity,
    socketPath: input.socketPath,
  };

  if (input.dryRun) {
    return planHandoffDryRun({
      base,
      expectedBuildVersion: input.expectedBuildVersion,
      clientFactory: input.clientFactory,
    });
  }

  try {
    const ensured = await input.ensureHost(
      {
        socketPath: input.socketPath,
        stateDir: input.stateDir,
        hostCommand: input.resolveHostCommand(),
        expectedBuildVersion: input.expectedBuildVersion,
        handoff: { fidelity: input.fidelity },
      },
      { clientFactory: input.clientFactory },
    );
    if (ensured.status !== "running") {
      return {
        ...base,
        status: "unavailable",
        message: ensured.error.message,
      };
    }
    try {
      if (ensured.ensuredBy === "handoff") {
        const adopted = ensured.handoffAdopt?.adopted ?? [];
        return {
          ...base,
          status: "completed",
          message: `Live handoff completed; successor adopted ${adopted.length} terminal(s).`,
          livePtyCount: adopted.length,
          adopted,
        };
      }
      if (ensured.ensuredBy === "reuse") {
        return {
          ...base,
          status: "refused",
          message: "Host already matches this build; handoff is unnecessary.",
        };
      }
      if (ensured.ensuredBy === "idle-replace") {
        return {
          ...base,
          status: "refused",
          message: "Host is idle; ordinary stop-if-idle replacement ran instead of handoff.",
          livePtyCount: 0,
        };
      }
      return {
        ...base,
        status: "unavailable",
        message: "No incumbent host was available for live handoff.",
      };
    } finally {
      ensured.client.dispose();
    }
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function planHandoffDryRun(input: {
  base: {
    action: "handoff";
    dryRun: boolean;
    fidelity: HostHandoffFidelity;
    socketPath: string;
  };
  expectedBuildVersion: string;
  clientFactory: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
}): Promise<HostHandoffResult> {
  const client = input.clientFactory(input.base.socketPath, input.expectedBuildVersion);
  try {
    const health = await client.health();
    const compatibility = classifyHostCompatibility(health, input.expectedBuildVersion);
    if (compatibility.action === "refuse") {
      return {
        ...input.base,
        status: "refused",
        message: "Host protocol is incompatible; live handoff is refused.",
      };
    }
    if (compatibility.action === "reuse") {
      return {
        ...input.base,
        status: "refused",
        message: "Host already matches this build; handoff is unnecessary.",
      };
    }
    let livePtyCount = -1;
    try {
      livePtyCount = (await client.list()).length;
    } catch {
      livePtyCount = -1;
    }
    if (livePtyCount === 0) {
      return {
        ...input.base,
        status: "refused",
        message: "Host is idle; use ordinary stop-if-idle replacement instead of handoff.",
        livePtyCount: 0,
      };
    }
    return {
      ...input.base,
      status: "planned",
      message: `Would beginHandoff(fidelity=${input.base.fidelity}) → completeHandoff → spawn successor → adoptRegistry.`,
      ...(livePtyCount < 0 ? {} : { livePtyCount }),
    };
  } catch (error) {
    return {
      ...input.base,
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.dispose();
  }
}

function resolveStationHostEntry(): string {
  const fromEnv = process.env.STATION_HOST_ENTRY;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  return join(repoRoot, "station/src/host/hostMain.ts");
}

function resolveStationHostCommand(): readonly [string, ...string[]] {
  return selfExecArgv("station-host", [
    process.env.STATION_BUN ?? "bun",
    resolveStationHostEntry(),
  ]);
}
