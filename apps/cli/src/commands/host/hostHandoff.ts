import {
  type HostHandoffFidelity,
  type SafeError,
  type StationHostConvergenceCommand,
  type StationHostInspectionResult,
  type StationHostTargetBuild,
  stationHostEvidenceMatchesTargetBuild,
  stationHostTerminalsAreHandoffEligible,
} from "@station/contracts";
import { stationHostErrorFromUnknown } from "@station/host";
import type { convergeStationHost } from "@station/terminal";

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
  error?: SafeError;
};

type HandoffResultBase = Pick<HostHandoffResult, "action" | "dryRun" | "fidelity" | "socketPath">;

/** Performs the standalone Host handoff workflow for the public Host command. */
export async function runHostHandoff(
  input: {
    socketPath: string;
    stateDir: string;
    targetBuild: StationHostTargetBuild;
    dryRun: boolean;
    fidelity: HostHandoffFidelity;
    inspection: StationHostInspectionResult;
  },
  deps: {
    convergeHost: typeof convergeStationHost;
    resolveHostCommand: () => readonly [string, ...string[]];
    now: () => number;
  },
): Promise<HostHandoffResult> {
  const base: HandoffResultBase = {
    action: "handoff",
    dryRun: input.dryRun,
    fidelity: input.fidelity,
    socketPath: input.socketPath,
  };
  if (input.inspection.status !== "exact") {
    return projectUnavailableHandoff(input.inspection, base);
  }

  const evidence = input.inspection.evidence;
  if (stationHostEvidenceMatchesTargetBuild(evidence, input.targetBuild)) {
    return {
      ...base,
      status: "refused",
      message: "Host already matches this build; handoff is unnecessary.",
    };
  }
  if (
    evidence.terminals.length > 0 &&
    !stationHostTerminalsAreHandoffEligible(evidence.terminals)
  ) {
    return ineligibleHandoff(evidence.terminals.length, base);
  }
  if (input.dryRun) return projectDryRun(evidence.terminals.length, input.fidelity, base);

  const command = buildConvergenceCommand(
    {
      socketPath: input.socketPath,
      targetBuild: input.targetBuild,
      fidelity: input.fidelity,
      evidence,
    },
    deps.now() + 12_000,
  );
  try {
    const result = await deps.convergeHost({
      command,
      targetBuild: input.targetBuild,
      socketPath: input.socketPath,
      stateDir: input.stateDir,
      hostCommand: deps.resolveHostCommand(),
    });
    if (result.status === "failed") {
      return {
        ...base,
        status: "unavailable",
        message: result.error.message,
        error: result.error,
      };
    }
    if (result.action === "replace-idle") {
      return {
        ...base,
        status: "refused",
        message: "Host is idle; ordinary stop-if-idle replacement ran instead of handoff.",
        livePtyCount: 0,
      };
    }
    const adopted = result.handoffReceipt.terminals.map(({ ptyId }) => ptyId);
    return {
      ...base,
      status: "completed",
      message: `Live handoff completed; successor adopted ${adopted.length} terminal(s).`,
      livePtyCount: adopted.length,
      adopted,
    };
  } catch (error) {
    const safeError = stationHostErrorFromUnknown(error, {
      code: "HOST_REQUEST_FAILED",
      message: "Station Host handoff failed.",
    });
    return {
      ...base,
      status: "unavailable",
      message: safeError.message,
      error: safeError,
    };
  }
}

function normalizeUnavailableMessage(
  inspection: Exclude<StationHostInspectionResult, { status: "exact" }>,
): string {
  if (
    inspection.status === "unknown" &&
    inspection.reason === "health-failed" &&
    inspection.error.code === "HOST_VERSION_INCOMPATIBLE"
  ) {
    return "Host protocol is incompatible; live handoff is refused.";
  }
  return inspection.status === "absent" || inspection.status === "stale"
    ? "No incumbent host was available for live handoff."
    : inspection.error.message;
}

function projectUnavailableHandoff(
  inspection: Exclude<StationHostInspectionResult, { status: "exact" }>,
  base: HandoffResultBase,
): HostHandoffResult {
  const incompatible =
    inspection.status === "unknown" &&
    inspection.reason === "health-failed" &&
    inspection.error.code === "HOST_VERSION_INCOMPATIBLE";
  return {
    ...base,
    status: incompatible ? "refused" : "unavailable",
    message: normalizeUnavailableMessage(inspection),
  };
}

function projectDryRun(
  livePtyCount: number,
  fidelity: HostHandoffFidelity,
  base: HandoffResultBase,
): HostHandoffResult {
  if (livePtyCount === 0) {
    return {
      ...base,
      status: "refused",
      message: "Host is idle; use ordinary stop-if-idle replacement instead of handoff.",
      livePtyCount,
    };
  }
  return {
    ...base,
    status: "planned",
    message: `Would beginHandoff(fidelity=${fidelity}) → completeHandoff → spawn successor → adoptRegistry.`,
    livePtyCount,
  };
}

function ineligibleHandoff(livePtyCount: number, base: HandoffResultBase): HostHandoffResult {
  return {
    ...base,
    status: "refused",
    message: "Host terminals are not all eligible for live handoff.",
    livePtyCount,
  };
}

function buildConvergenceCommand(
  input: {
    socketPath: string;
    targetBuild: StationHostTargetBuild;
    fidelity: HostHandoffFidelity;
    evidence: Extract<StationHostInspectionResult, { status: "exact" }>["evidence"];
  },
  deadlineMs: number,
): StationHostConvergenceCommand {
  const common = {
    targetBuild: input.targetBuild,
    socketPath: input.socketPath,
    expected: input.evidence,
    deadlineMs,
  };
  return input.evidence.terminals.length === 0
    ? { ...common, action: "replace-idle" }
    : { ...common, action: "handoff", fidelity: input.fidelity };
}
