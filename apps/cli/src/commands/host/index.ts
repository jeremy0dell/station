import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StationConfig, stationHostSocketPath } from "@station/config";
import type { HostHandoffCommandResult, HostHandoffFidelity } from "@station/contracts";
import {
  classifyHostCompatibility,
  createStationHostClient,
  type HostHealthResult,
  type HostListEntry,
  type HostPtyHandoffSupport,
  type StationHostClient,
} from "@station/host";
import { probeUnixSocket } from "@station/protocol";
import { isSafeError, stationBuildInfo } from "@station/runtime";
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
  /** Immutable content identity required when update convergence must distinguish same-version builds. */
  expectedBuildIdentity?: string;
};

export type HostInspectionEntry = HostListEntry & {
  handoffSupport?: HostPtyHandoffSupport;
};

export type HostStatusResult = {
  action: "status";
  socketPath: string;
  probe: string;
  health?: HostHealthResult;
  compatibility?: ReturnType<typeof classifyHostCompatibility>;
  buildIdentity?: string;
  livePtyCount?: number;
  ptys?: HostInspectionEntry[];
  handoffEligible?: boolean;
  error?: string;
};

export type HostCommandResult = HostStatusResult | HostHandoffCommandResult;

export type HostCommandOptions = {
  config: StationConfig;
};

/**
 * ADAPTER
 *
 * Drive Station host inspection and opt-in live handoff from the CLI without
 * routing through Observer application code. Mutating handoff defers policy to
 * `ensureStationHostRunning`; this layer projects its exact immutable PTY receipt at the strict JSON
 * boundary.
 */
export async function runHostCommand(
  args: readonly string[],
  options: HostCommandOptions,
  deps: HostCommandDeps = {},
): Promise<HostCommandResult> {
  const parsed = parseHostArgs(args);
  const socketPath = stationHostSocketPath(options.config);
  const stateDir = resolveObserverPaths(options.config).stateDir;
  const processBuild = deps.expectedBuildVersion === undefined ? stationBuildInfo() : undefined;
  const expectedBuildVersion = deps.expectedBuildVersion ?? processBuild?.version;
  if (expectedBuildVersion === undefined)
    throw new Error("Expected Host build version is missing.");
  const expectedBuildIdentity = deps.expectedBuildIdentity ?? processBuild?.buildIdentity;
  const clientFactory =
    deps.clientFactory ??
    ((path, build) => createStationHostClient({ socketPath: path, expectedBuildVersion: build }));

  if (parsed.action === "status") {
    const statusInput: Parameters<typeof runHostStatus>[0] = {
      socketPath,
      expectedBuildVersion,
      clientFactory,
    };
    if (expectedBuildIdentity !== undefined)
      statusInput.expectedBuildIdentity = expectedBuildIdentity;
    return runHostStatus(statusInput);
  }
  const handoffInput: Parameters<typeof runHostHandoff>[0] = {
    socketPath,
    stateDir,
    expectedBuildVersion,
    dryRun: parsed.dryRun,
    fidelity: parsed.fidelity,
    clientFactory,
    ensureHost: deps.ensureHost ?? ensureStationHostRunning,
    resolveHostCommand: deps.resolveHostCommand ?? resolveStationHostCommand,
  };
  if (expectedBuildIdentity !== undefined)
    handoffInput.expectedBuildIdentity = expectedBuildIdentity;
  return runHostHandoff(handoffInput);
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
  if (result.receipt !== undefined) {
    lines.push(`adopted: ${result.receipt.terminals.length}`);
  }
  return `${lines.join("\n")}\n`;
}

async function runHostStatus(input: {
  socketPath: string;
  expectedBuildVersion: string;
  expectedBuildIdentity?: string;
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
    let compatibility = classifyHostCompatibility(health, input.expectedBuildVersion);
    // Inventory stays read-only but must pass the client's exact incumbent-build gate.
    const inventoryClient =
      compatibility.action === "replace"
        ? input.clientFactory(input.socketPath, compatibility.runningBuildVersion)
        : client;
    try {
      let ptys: HostInspectionEntry[];
      if (inventoryClient.recoveryInventory === undefined) {
        ptys = await inventoryClient.list();
      } else {
        try {
          const recovery = await inventoryClient.recoveryInventory();
          result.buildIdentity = recovery.buildIdentity;
          if (compatibility.action === "reuse" && input.expectedBuildIdentity !== undefined) {
            compatibility =
              recovery.buildIdentity === input.expectedBuildIdentity
                ? compatibility
                : { action: "replace", runningBuildVersion: input.expectedBuildVersion };
          }
          ptys = recovery.ptys;
        } catch (error) {
          if (!isSafeError(error) || error.code !== "HOST_BAD_REQUEST") throw error;
          // Older protocol-v8 Hosts do not implement the additive recovery query.
          ptys = await inventoryClient.list();
        }
      }
      result.ptys = ptys;
      if (
        compatibility.action === "reuse" &&
        input.expectedBuildIdentity !== undefined &&
        result.buildIdentity === undefined
      ) {
        compatibility = { action: "refuse", reason: "legacy-health" };
      }
      result.compatibility = compatibility;
      result.livePtyCount = ptys.length;
      result.handoffEligible = compatibility.action === "replace" && ptys.length > 0;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      result.handoffEligible = compatibility.action === "replace";
    } finally {
      if (inventoryClient !== client) inventoryClient.dispose();
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
  expectedBuildIdentity?: string;
  dryRun: boolean;
  fidelity: HostHandoffFidelity;
  clientFactory: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
  ensureHost: typeof ensureStationHostRunning;
  resolveHostCommand: () => readonly [string, ...string[]];
}): Promise<HostHandoffCommandResult> {
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
        ...(input.expectedBuildIdentity === undefined
          ? {}
          : { expectedBuildIdentity: input.expectedBuildIdentity }),
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
        const receipt = ensured.handoffAdopt?.receipt;
        if (receipt === undefined) {
          return {
            ...base,
            status: "unavailable",
            message: "Successor Host did not return an exact terminal handoff receipt.",
          };
        }
        return {
          ...base,
          status: "completed",
          message: `Live handoff completed; successor adopted ${receipt.terminals.length} terminal(s).`,
          livePtyCount: receipt.terminals.length,
          receipt,
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
          status: "completed",
          message: "Idle Host replacement completed without terminal handoff.",
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
}): Promise<HostHandoffCommandResult> {
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
