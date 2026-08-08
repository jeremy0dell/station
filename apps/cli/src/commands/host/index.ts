import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StationConfig, stationHostSocketPath } from "@station/config";
import type { HostHandoffFidelity } from "@station/contracts";
import {
  classifyHostCompatibility,
  createStationHostClient,
  type HostHealthResult,
  type HostListEntry,
  type StationHostClient,
} from "@station/host";
import { probeUnixSocket } from "@station/protocol";
import { stationBuildInfo } from "@station/runtime";
import { ensureStationHostRunning } from "@station/terminal";
import { resolveObserverPaths } from "../../paths.js";
import { selfExecArgv } from "../../selfExec.js";
import { parseHostArgs } from "./args.js";

export type HostCommandDeps = {
  clientFactory?: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
  ensureHost?: typeof ensureStationHostRunning;
  resolveHostCommand?: () => readonly [string, ...string[]];
  /** Test/composition override for the requesting Station build identity. */
  expectedBuildVersion?: string;
};

export type HostStatusResult = {
  action: "status";
  socketPath: string;
  probe: string;
  health?: HostHealthResult;
  compatibility?: ReturnType<typeof classifyHostCompatibility>;
  livePtyCount?: number;
  ptys?: HostListEntry[];
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
  adopted?: string[];
  failed?: Array<{ ptyId: string; reason: string }>;
};

export type HostCommandResult = HostStatusResult | HostHandoffResult;

export type HostCommandOptions = {
  config: StationConfig;
};

/**
 * ADAPTER
 *
 * Drive Station host inspection and opt-in live handoff from the CLI without
 * routing through Observer application code.
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
    return runHostStatus({ socketPath, expectedBuildVersion, clientFactory });
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
        `health: ok protocol=${result.health.protocolVersion} build=${result.health.buildVersion ?? "(legacy)"}`,
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
  if (result.failed !== undefined && result.failed.length > 0) {
    lines.push(`failed: ${result.failed.map((item) => `${item.ptyId}:${item.reason}`).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

async function runHostStatus(input: {
  socketPath: string;
  expectedBuildVersion: string;
  clientFactory: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
}): Promise<HostStatusResult> {
  const probe = await probeUnixSocket(input.socketPath);
  const result: HostStatusResult = {
    action: "status",
    socketPath: input.socketPath,
    probe: probe.status,
  };
  if (probe.status !== "listening") {
    result.error = "Host socket is not listening.";
    return result;
  }
  const client = input.clientFactory(input.socketPath, input.expectedBuildVersion);
  try {
    const health = await client.health();
    result.health = health;
    const compatibility = classifyHostCompatibility(health, input.expectedBuildVersion);
    result.compatibility = compatibility;
    try {
      const ptys = await client.list();
      result.ptys = ptys;
      result.livePtyCount = ptys.length;
      result.handoffEligible = compatibility.action === "replace" && ptys.length > 0;
    } catch (error) {
      // list requires matching identity; status still reports health/compat
      result.error = error instanceof Error ? error.message : String(error);
      result.handoffEligible = compatibility.action === "replace";
    }
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    client.dispose();
  }
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
    dryRun: input.dryRun,
    fidelity: input.fidelity,
    socketPath: input.socketPath,
  };
  let livePtyCount = -1;
  const client = input.clientFactory(input.socketPath, input.expectedBuildVersion);
  try {
    const health = await client.health();
    const compatibility = classifyHostCompatibility(health, input.expectedBuildVersion);
    if (compatibility.action === "refuse") {
      return handoffResult(base, {
        status: "refused",
        message: "Host protocol is incompatible; live handoff is refused.",
      });
    }
    if (compatibility.action === "reuse") {
      return handoffResult(base, {
        status: "refused",
        message: "Host already matches this build; handoff is unnecessary.",
      });
    }

    try {
      livePtyCount = (await client.list()).length;
    } catch {
      // Older identity mismatch on list — treat as unknown/busy for planning.
      livePtyCount = -1;
    }

    if (livePtyCount === 0) {
      return handoffResult(base, {
        status: "refused",
        message: "Host is idle; use ordinary stop-if-idle replacement instead of handoff.",
        livePtyCount: 0,
      });
    }

    if (input.dryRun) {
      return handoffResult(
        { ...base, dryRun: true },
        {
          status: "planned",
          message: `Would beginHandoff(fidelity=${input.fidelity}) → completeHandoff → spawn successor → adoptRegistry.`,
          ...(livePtyCount < 0 ? {} : { livePtyCount }),
        },
      );
    }
  } catch (error) {
    return handoffResult(base, {
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.dispose();
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
      return handoffResult(
        { ...base, dryRun: false },
        {
          status: "unavailable",
          message: ensured.error.message,
          ...(livePtyCount < 0 ? {} : { livePtyCount }),
        },
      );
    }
    try {
      const ptys = await ensured.client.list();
      return handoffResult(
        { ...base, dryRun: false },
        {
          status: "completed",
          message: `Live handoff completed; successor serves ${ptys.length} terminal(s).`,
          livePtyCount: ptys.length,
          adopted: ptys.map((pty) => pty.ptyId),
        },
      );
    } finally {
      ensured.client.dispose();
    }
  } catch (error) {
    return handoffResult(base, {
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function handoffResult(
  base: {
    dryRun: boolean;
    fidelity: HostHandoffFidelity;
    socketPath: string;
  },
  fields: {
    status: HostHandoffResult["status"];
    message: string;
    livePtyCount?: number;
    adopted?: string[];
    failed?: Array<{ ptyId: string; reason: string }>;
  },
): HostHandoffResult {
  const result: HostHandoffResult = {
    action: "handoff",
    dryRun: base.dryRun,
    fidelity: base.fidelity,
    socketPath: base.socketPath,
    status: fields.status,
    message: fields.message,
  };
  if (fields.livePtyCount !== undefined) {
    result.livePtyCount = fields.livePtyCount;
  }
  if (fields.adopted !== undefined) {
    result.adopted = fields.adopted;
  }
  if (fields.failed !== undefined) {
    result.failed = fields.failed;
  }
  return result;
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
