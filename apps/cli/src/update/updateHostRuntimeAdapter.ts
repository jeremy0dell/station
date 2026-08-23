import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StationConfig, stationHostSocketPath } from "@station/config";
import {
  comparePtyLifetimeIdentities,
  type SafeError,
  type UpdateArtifact,
  type UpdateHostConvergenceCommand,
  type UpdateHostConvergenceCommandResult,
  UpdateHostConvergenceCommandResultSchema,
  type UpdateReapHostEvidence,
  type UpdateReapTerminalEvidence,
} from "@station/contracts";
import {
  createStationHostClient,
  type StationHostClient,
  stationHostSafeError,
} from "@station/host";
import type { StationBuildInfo } from "@station/runtime";
import {
  convergeStationHostForUpdate,
  inspectStationHost,
  type StationHostCommand,
  type StationHostInspection,
} from "@station/terminal";
import { resolveObserverPaths } from "../paths.js";
import { selfExecArgv } from "../selfExec.js";
import { redactedPreflightError } from "./recoveryPreflight.js";
import { classifyUpdateRuntimeBuildRelation } from "./runtimeBuildRelation.js";
import type { UpdateHostRuntimePort } from "./updateHostRuntimePort.js";

export type UpdateHostRuntimeAdapterOptions = {
  config: StationConfig;
  buildInfo: () => StationBuildInfo;
};

export type UpdateHostRuntimeAdapterDeps = {
  clientFactory?: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
  inspectHost?: typeof inspectStationHost;
  convergeHost?: typeof convergeStationHostForUpdate;
  resolveHostCommand?: () => StationHostCommand;
};

/**
 * ADAPTER
 *
 * Translates the update Host port into direct typed socket inspection and constrained Station Host
 * convergence with exact session-bound inventory and fidelity receipts. No update action passes
 * through CLI text or generic handoff behavior.
 */
export function createUpdateHostRuntimeAdapter(
  options: UpdateHostRuntimeAdapterOptions,
  deps: UpdateHostRuntimeAdapterDeps = {},
): UpdateHostRuntimePort {
  const socketPath = stationHostSocketPath(options.config);
  const stateDir = resolveObserverPaths(options.config).stateDir;
  const clientFactory =
    deps.clientFactory ??
    ((path, build) => createStationHostClient({ socketPath: path, expectedBuildVersion: build }));
  const inspectHost = deps.inspectHost ?? inspectStationHost;
  const convergeHost = deps.convergeHost ?? convergeStationHostForUpdate;
  const resolveHostCommand = deps.resolveHostCommand ?? resolveStationHostCommand;

  const runConvergence = async (
    command: UpdateHostConvergenceCommand,
  ): Promise<UpdateHostConvergenceCommandResult> => {
    const build = options.buildInfo();
    if (
      build.version !== command.commitment.target.buildVersion ||
      build.buildIdentity !== command.commitment.target.buildIdentity
    ) {
      return staleResult(
        command,
        "The executing Station CLI does not match the selected target Host build commitment.",
      );
    }
    return UpdateHostConvergenceCommandResultSchema.parse(
      await convergeHost(
        {
          socketPath,
          stateDir,
          hostCommand: resolveHostCommand(),
          command,
        },
        { clientFactory },
      ),
    );
  };

  return {
    inspect: async (artifacts) => {
      const build = options.buildInfo();
      const inspection = await inspectHost(
        {
          socketPath,
          expectedBuildVersion: artifacts.target.version,
          expectedBuildIdentity: build.buildIdentity,
        },
        { clientFactory },
      );
      return publicHostEvidence(inspection, artifacts, build.buildIdentity);
    },
    replaceIdleHost: (commitment) =>
      runConvergence({ schemaVersion: 1, action: "replace-idle", commitment }),
    handoffHost: (fidelity, commitment) =>
      runConvergence({ schemaVersion: 1, action: "handoff", fidelity, commitment }),
  };
}

function publicHostEvidence(
  inspection: StationHostInspection,
  artifacts: { installed: UpdateArtifact; target: UpdateArtifact },
  currentBuildIdentity: string,
): UpdateReapHostEvidence {
  if (inspection.probe === "absent") return { status: "absent" };
  if (inspection.probe === "stale") {
    return hostUnknown(
      "stale-socket",
      "UPDATE_PREFLIGHT_HOST_STALE",
      "Host socket evidence is stale.",
    );
  }
  if (inspection.probe === "inaccessible") {
    return hostUnknown(
      "inaccessible",
      "UPDATE_PREFLIGHT_HOST_INACCESSIBLE",
      "Host socket ownership is inaccessible.",
    );
  }
  if (inspection.health === undefined || inspection.compatibility === undefined) {
    return hostUnknown(
      "health-failed",
      "UPDATE_PREFLIGHT_HOST_HEALTH_FAILED",
      "Host health and compatibility could not be established.",
      inspection.error,
    );
  }
  if (inspection.ptys === undefined) {
    return hostUnknown(
      "inventory-failed",
      "UPDATE_PREFLIGHT_HOST_INVENTORY_FAILED",
      "Host terminal inventory could not be read.",
      inspection.error,
    );
  }

  const evidence: Extract<UpdateReapHostEvidence, { status: "inspected" }> = {
    status: "inspected",
    protocolVersion: inspection.health.protocolVersion,
    relation: classifyUpdateRuntimeBuildRelation({
      runningDisplayVersion: inspection.health.buildVersion,
      runningBuildIdentity: inspection.buildIdentity,
      currentBuildIdentity,
      artifacts,
    }),
    compatibility: inspection.compatibility.action,
    terminals: inspection.ptys.map(redactedHostTerminal).sort(compareHostTerminal),
  };
  if (inspection.health.buildVersion !== undefined) {
    evidence.buildVersion = inspection.health.buildVersion;
  }
  if (inspection.buildIdentity !== undefined) evidence.buildIdentity = inspection.buildIdentity;
  return evidence;
}

function redactedHostTerminal(terminal: StationHostInspectionEntry): UpdateReapTerminalEvidence {
  return {
    kind: terminal.kind,
    terminalTargetId: terminal.terminalTargetId,
    ptyId: terminal.ptyId,
    ptyInstanceId: terminal.ptyInstanceId,
    projectId: terminal.projectId,
    worktreeId: terminal.worktreeId,
    sessionId: terminal.sessionId,
    harnessProvider: terminal.harnessProvider,
    alive: terminal.alive,
    handoffSupport: terminal.handoffSupport?.kind ?? "unknown",
  };
}

type StationHostInspectionEntry = NonNullable<StationHostInspection["ptys"]>[number];

function compareHostTerminal(
  left: UpdateReapTerminalEvidence,
  right: UpdateReapTerminalEvidence,
): number {
  return comparePtyLifetimeIdentities(left, right);
}

function hostUnknown(
  reason: Extract<UpdateReapHostEvidence, { status: "unknown" }>["reason"],
  code: string,
  message: string,
  cause?: SafeError,
): UpdateReapHostEvidence {
  return { status: "unknown", reason, error: redactedPreflightError(cause, { code, message }) };
}

function staleResult(
  command: UpdateHostConvergenceCommand,
  message: string,
): UpdateHostConvergenceCommandResult {
  return UpdateHostConvergenceCommandResultSchema.parse({
    schemaVersion: 1,
    action: "update-converge",
    requestedAction: command.action,
    ...(command.action === "handoff" ? { requestedFidelity: command.fidelity } : {}),
    status: "stale",
    error: stationHostSafeError("HOST_CONVERGENCE_PLAN_DRIFT", message),
  });
}

function resolveStationHostEntry(): string {
  const fromEnv = process.env.STATION_HOST_ENTRY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  return join(repoRoot, "station/src/host/hostMain.ts");
}

function resolveStationHostCommand(): StationHostCommand {
  return selfExecArgv("station-host", [
    process.env.STATION_BUN ?? "bun",
    resolveStationHostEntry(),
  ]);
}
