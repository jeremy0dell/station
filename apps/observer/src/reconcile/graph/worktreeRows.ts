import type {
  ClientFeatureFlags,
  HarnessCapabilities,
  HarnessRunObservation,
  ProviderProjectConfig,
  SessionRecoveryHandle,
  TerminalAttachment,
  TerminalTargetObservation,
  WorktreeObservation,
  WorktreeRecoveryAction,
  WorktreeRow,
} from "@station/contracts";
import { worktreeDisplayForAgentState, worktreeHasLiveAgent } from "@station/contracts";
import { sessionRecoveryEligibility } from "../../sessionRecovery/eligibility.js";
import { selectNewestSessionRecoveryCandidate } from "../../sessionRecovery/selection.js";
import { terminalControlEvidence } from "../terminalControlEvidence.js";
import type { ObserverSessionMetadata, ObserverTurnReadiness } from "./evidence.js";

function hasPrimaryAgentEndpoint(
  terminal: TerminalTargetObservation,
  harnessRun: HarnessRunObservation | undefined,
): boolean {
  return (
    terminal.harnessBinding?.role === "main-agent" ||
    terminal.harnessRunId !== undefined ||
    terminal.sessionId !== undefined ||
    harnessRun !== undefined
  );
}

export type BuildWorktreeRowInput = {
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  title: string;
  terminal?: TerminalTargetObservation;
  harnessRun?: HarnessRunObservation;
  terminalCapabilities?: Record<string, boolean>;
};

export function buildWorktreeRow(input: BuildWorktreeRowInput): WorktreeRow {
  const display = worktreeDisplayForAgentState(input.harnessRun?.status.value);
  const warning = warningFor(input.harnessRun, input.terminal, display.warning === true);
  const reason = displayReason(input.harnessRun, display.alert || warning);
  const worktree: WorktreeRow["worktree"] = {
    state: input.worktree.state,
    source: input.worktree.source,
  };
  if (input.worktree.dirty !== undefined) worktree.dirty = input.worktree.dirty;
  if (input.worktree.ahead !== undefined) worktree.ahead = input.worktree.ahead;
  if (input.worktree.behind !== undefined) worktree.behind = input.worktree.behind;
  if (input.worktree.pr !== undefined) worktree.pr = input.worktree.pr;
  if (input.worktree.changeSummary !== undefined) {
    worktree.changeSummary = input.worktree.changeSummary;
  }
  if (input.worktree.checks !== undefined) worktree.checks = input.worktree.checks;
  if (input.worktree.remote !== undefined) worktree.remote = input.worktree.remote;
  if (input.worktree.headSha !== undefined) worktree.headSha = input.worktree.headSha;

  if (warning) display.warning = true;
  if (reason !== undefined) display.reason = reason;

  const row: WorktreeRow = {
    id: input.worktree.id,
    projectId: input.project.id,
    projectLabel: input.project.label,
    title: input.title,
    branch: input.worktree.branch,
    path: input.worktree.path,
    worktree,
    display,
  };
  if (input.worktree.registrationIdentity !== undefined) {
    row.registrationIdentity = input.worktree.registrationIdentity;
  }
  if (input.terminal !== undefined)
    row.terminal = terminalAttachment(input.terminal, input.harnessRun, input.terminalCapabilities);
  if (input.harnessRun !== undefined) row.agent = rowAgent(input.harnessRun);
  return row;
}

export function attachTurnReadiness(
  row: WorktreeRow,
  readinessBySessionId: ReadonlyMap<string, ObserverTurnReadiness>,
): void {
  const agent = row.agent;
  if (agent?.state !== "idle" || agent.sessionId === undefined) {
    return;
  }
  const readiness = readinessBySessionId.get(agent.sessionId);
  if (
    readiness === undefined ||
    readiness.projectId !== row.projectId ||
    readiness.worktreeId !== row.id
  ) {
    return;
  }
  agent.turnReadiness = {
    state: "ready_to_read",
    token: readiness.token,
    completedAt: readiness.completedAt,
  };
}

export function recoveryActionForRow(input: {
  row: WorktreeRow;
  recoveryHandles: readonly SessionRecoveryHandle[];
  harnessCapabilities: Record<string, HarnessCapabilities>;
  sessionMetadata: readonly ObserverSessionMetadata[];
  retainedSession?: ObserverSessionMetadata | undefined;
  featureFlags?: ClientFeatureFlags | undefined;
}): WorktreeRecoveryAction | undefined {
  // Snapshots expose a safe action hint only. The observer resolves the handle
  // back to native ids/files when session.resumeAgent runs.
  if (input.featureFlags?.flags.sessionResumeAgent !== true || worktreeHasLiveAgent(input.row)) {
    return undefined;
  }

  const eligible = input.recoveryHandles.flatMap((handle) => {
    const capabilities = input.harnessCapabilities[handle.provider];
    const eligibilityInput: Parameters<typeof sessionRecoveryEligibility>[0] = {
      handle,
      projectId: input.row.projectId,
      worktreeId: input.row.id,
      worktreePath: input.row.path,
      stationSessions: input.sessionMetadata,
      allowNoLocalSession: true,
    };
    if (input.retainedSession?.harness !== undefined) {
      eligibilityInput.expectedSession = {
        id: input.retainedSession.id,
        harness: input.retainedSession.harness,
      };
    }
    if (capabilities !== undefined) {
      eligibilityInput.registeredHarness = {
        id: handle.provider,
        canResume: capabilities.canResume,
      };
    }
    return sessionRecoveryEligibility(eligibilityInput).kind === "eligible" ? [{ handle }] : [];
  });
  // Snapshot actions and launch resolution share one total order so reconcile cannot advertise a
  // different recovery target than the command will validate and launch.
  const selected = selectNewestSessionRecoveryCandidate(eligible);
  if (selected === undefined) {
    return undefined;
  }
  const handle = selected.handle;
  const action: WorktreeRecoveryAction = {
    kind: "agent-resume",
    handleId: handle.id,
    provider: handle.provider,
    targetKind: handle.target.kind,
    lastSeenAt: handle.lastSeenAt,
  };
  if (handle.sessionId !== undefined) action.sessionId = handle.sessionId;
  return action;
}

export function terminalAttachment(
  terminal: TerminalTargetObservation,
  harnessRun: HarnessRunObservation | undefined,
  capabilities?: Record<string, boolean> | undefined,
): TerminalAttachment {
  const attachment: TerminalAttachment = {
    provider: terminal.provider,
    state: terminal.state,
  };
  const control = terminalControlEvidence(terminal, capabilities);
  if (control.focusable !== undefined) attachment.focusable = control.focusable;
  if (control.closeable !== undefined) attachment.closeable = control.closeable;
  if (terminal.worktreeId !== undefined) attachment.hasWorkspace = true;
  if (hasPrimaryAgentEndpoint(terminal, harnessRun)) {
    attachment.hasPrimaryAgentEndpoint = true;
  }
  if (terminal.confidence !== undefined) attachment.confidence = terminal.confidence;
  if (terminal.reason !== undefined) attachment.reason = terminal.reason;
  if (terminal.observedAt !== undefined) attachment.observedAt = terminal.observedAt;
  return attachment;
}

function rowAgent(run: HarnessRunObservation): WorktreeRow["agent"] {
  const status = run.status;
  const agent: NonNullable<WorktreeRow["agent"]> = {
    harness: run.provider,
    state: status.value,
    runId: run.id,
    confidence: status.confidence,
    reason: status.reason,
    updatedAt: status.updatedAt,
  };
  if (status.attention !== undefined) agent.attention = status.attention;
  if (run.pid !== undefined) agent.pid = run.pid;
  if (run.sessionId !== undefined) agent.sessionId = run.sessionId;
  return agent;
}

export function compareRows(left: WorktreeRow, right: WorktreeRow): number {
  return (
    left.display.sortPriority - right.display.sortPriority ||
    left.branch.localeCompare(right.branch) ||
    left.id.localeCompare(right.id)
  );
}

function displayReason(
  harnessRun: HarnessRunObservation | undefined,
  includeReason: boolean,
): string | undefined {
  if (harnessRun === undefined) {
    return "No harness run is associated with this worktree.";
  }
  if (includeReason) {
    return harnessRun.status.reason;
  }
  return undefined;
}

function warningFor(
  harnessRun: HarnessRunObservation | undefined,
  terminal: TerminalTargetObservation | undefined,
  defaultWarning: boolean,
): boolean {
  if (defaultWarning) {
    return true;
  }
  if (harnessRun?.status.value !== "unknown") {
    return false;
  }

  const reason = `${harnessRun.status.reason} ${terminal?.reason ?? ""}`.toLowerCase();
  return (
    reason.includes("conflict") ||
    reason.includes("stale") ||
    reason.includes("failed") ||
    reason.includes("invalid")
  );
}
