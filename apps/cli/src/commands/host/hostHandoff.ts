import {
  type HostHandoffFidelity,
  type SafeError,
  type StationHostConvergenceCommand,
  type StationHostConvergenceFailureSummary,
  type StationHostInspectionResult,
  type StationHostTargetBuild,
  stationHostEvidenceMatchesTargetBuild,
  stationHostTerminalsAreHandoffEligible,
  summarizeStationHostConvergenceFailure,
} from "@station/contracts";
import { stationHostErrorFromUnknown } from "@station/host";
import type {
  convergeStationHost,
  preflightParkedOrphanRecovery,
  recoverExactStationHostOrphans,
} from "@station/terminal";

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
  /** Durable parked PTYs additionally recovered by updater-only convergence. */
  recovered?: string[];
  /** Redacted convergence facts retained only for updater failure projection. */
  convergenceFailure?: StationHostConvergenceFailureSummary;
  /** Safe failure retained by updater-only process projection. */
  error?: SafeError;
};

type HandoffResultBase = Pick<HostHandoffResult, "action" | "dryRun" | "fidelity" | "socketPath">;

/**
 * Projects strict Host convergence into either the standalone handoff contract or the updater's
 * idempotent crossover contract. The updater projection changes success classification only; it
 * does not add mutation authority beyond canonical convergence.
 */
export async function runHostHandoff(
  input: {
    socketPath: string;
    stateDir: string;
    targetBuild: StationHostTargetBuild;
    dryRun: boolean;
    fidelity: HostHandoffFidelity;
    /** Maps no-op and idle-replacement outcomes to success for update recovery. */
    updateCrossover: boolean;
    /** Requires future replacement viability even when preflight observes the current exact build. */
    replacementRequired: boolean;
    inspection: StationHostInspectionResult;
  },
  deps: {
    convergeHost: typeof convergeStationHost;
    preflightHostOrphans: typeof preflightParkedOrphanRecovery;
    recoverHostOrphans: typeof recoverExactStationHostOrphans;
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
  if (input.updateCrossover && input.dryRun) {
    try {
      await deps.preflightHostOrphans({
        stateDir: input.stateDir,
        ...(input.inspection.status === "exact"
          ? { currentHostEvidence: input.inspection.evidence }
          : {}),
      });
    } catch (error) {
      const safeError = normalizeHostHandoffError(error);
      return {
        ...base,
        status: "unavailable",
        message: safeError.message,
        error: safeError,
      };
    }
  }
  if (input.inspection.status !== "exact") {
    if (
      input.updateCrossover &&
      !input.dryRun &&
      (input.inspection.status === "absent" || input.inspection.status === "stale")
    ) {
      return recoverUpdateOrphans(input, base, deps, 0, "no incumbent");
    }
    return projectUnavailableHandoff(input.inspection, base, input.updateCrossover, input.dryRun);
  }

  const evidence = input.inspection.evidence;
  if (stationHostEvidenceMatchesTargetBuild(evidence, input.targetBuild)) {
    if (input.updateCrossover) {
      if (
        input.dryRun &&
        input.replacementRequired &&
        evidence.terminals.length > 0 &&
        !stationHostTerminalsAreHandoffEligible(evidence.terminals)
      ) {
        return ineligibleHandoff(evidence.terminals.length, base);
      }
      if (input.dryRun) return projectDryRun(evidence.terminals.length, input.fidelity, base, true);
      return recoverUpdateOrphans(input, base, deps, evidence.terminals.length);
    }
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
  if (input.dryRun) {
    return projectDryRun(evidence.terminals.length, input.fidelity, base, input.updateCrossover);
  }

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
        convergenceFailure: summarizeStationHostConvergenceFailure(result),
      };
    }
    if (result.action === "replace-idle") {
      if (input.updateCrossover) {
        return recoverUpdateOrphans(input, base, deps, 0, "idle replacement");
      }
      return {
        ...base,
        status: "refused",
        message: "Host is idle; ordinary stop-if-idle replacement ran instead of handoff.",
        livePtyCount: 0,
      };
    }
    const adopted = result.handoffReceipt.terminals.map(({ ptyId }) => ptyId);
    if (input.updateCrossover) {
      const recovered = await deps.recoverHostOrphans({
        socketPath: input.socketPath,
        stateDir: input.stateDir,
        targetBuild: input.targetBuild,
        hostCommand: deps.resolveHostCommand(),
      });
      return {
        ...base,
        status: "completed",
        message: `Live handoff completed; successor adopted ${adopted.length} terminal(s).`,
        livePtyCount: adopted.length + recovered.recoveredPtyIds.length,
        adopted,
        ...(recovered.recoveredPtyIds.length === 0 ? {} : { recovered: recovered.recoveredPtyIds }),
      };
    }
    return {
      ...base,
      status: "completed",
      message: `Live handoff completed; successor adopted ${adopted.length} terminal(s).`,
      livePtyCount: adopted.length,
      adopted,
    };
  } catch (error) {
    const safeError = normalizeHostHandoffError(error);
    return {
      ...base,
      status: "unavailable",
      message: safeError.message,
      error: safeError,
    };
  }
}

async function recoverUpdateOrphans(
  input: Parameters<typeof runHostHandoff>[0],
  base: HandoffResultBase,
  deps: Parameters<typeof runHostHandoff>[1],
  livePtyCount = 0,
  completedBy?: string,
): Promise<HostHandoffResult> {
  try {
    const recovered = await deps.recoverHostOrphans({
      socketPath: input.socketPath,
      stateDir: input.stateDir,
      targetBuild: input.targetBuild,
      hostCommand: deps.resolveHostCommand(),
    });
    return {
      ...base,
      status: "completed",
      message:
        completedBy === undefined
          ? "Host already has exact ownership for the update build."
          : completedBy === "no incumbent"
            ? recovered.recoveredPtyIds.length === 0
              ? "No incumbent Host or parked terminal required update crossover."
              : `Started the exact update Host and recovered ${recovered.recoveredPtyIds.length} parked terminal(s).`
            : `Host exact ownership converged by ${completedBy}.`,
      livePtyCount: livePtyCount + recovered.recoveredPtyIds.length,
      ...(recovered.recoveredPtyIds.length === 0 ? {} : { recovered: recovered.recoveredPtyIds }),
    };
  } catch (error) {
    const safeError = normalizeHostHandoffError(error);
    return {
      ...base,
      status: "unavailable",
      message: safeError.message,
      error: safeError,
    };
  }
}

function normalizeHostHandoffError(error: unknown): SafeError {
  return stationHostErrorFromUnknown(error, {
    code: "HOST_REQUEST_FAILED",
    message: "Station Host crossover failed.",
  });
}

function projectUnavailableHandoff(
  inspection: Exclude<StationHostInspectionResult, { status: "exact" }>,
  base: HandoffResultBase,
  updateCrossover: boolean,
  dryRun: boolean,
): HostHandoffResult {
  switch (inspection.status) {
    case "absent":
    case "stale":
      if (updateCrossover) {
        return {
          ...base,
          status: dryRun ? "planned" : "completed",
          message: dryRun
            ? "No incumbent Host currently requires update crossover."
            : "No incumbent Host required update crossover.",
          livePtyCount: 0,
        };
      }
      return {
        ...base,
        status: "unavailable",
        message: "No incumbent host was available for live handoff.",
      };
    case "inaccessible":
      return {
        ...base,
        status: "unavailable",
        message: inspection.error.message,
      };
    case "unknown":
      return inspection.reason === "health-failed" &&
        inspection.error.code === "HOST_VERSION_INCOMPATIBLE"
        ? {
            ...base,
            status: "refused",
            message: "Host protocol is incompatible; live handoff is refused.",
          }
        : { ...base, status: "unavailable", message: inspection.error.message };
  }
}

function projectDryRun(
  livePtyCount: number,
  fidelity: HostHandoffFidelity,
  base: HandoffResultBase,
  updateCrossover = false,
): HostHandoffResult {
  if (livePtyCount === 0 && !updateCrossover)
    return {
      ...base,
      status: "refused",
      message: "Host is idle; use ordinary stop-if-idle replacement instead of handoff.",
      livePtyCount,
    };
  return {
    ...base,
    status: "planned",
    message:
      livePtyCount === 0
        ? "Would converge exact Host ownership by idle replacement if still required."
        : `Would beginHandoff(fidelity=${fidelity}) → completeHandoff → spawn successor → adoptRegistry.`,
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
