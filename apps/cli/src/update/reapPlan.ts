import { createHash } from "node:crypto";
import type {
  ObserverRecoveryAssessment,
  StationHostExactEvidence,
  UpdateArtifact,
  UpdateChannelId,
  UpdateConvergencePlan,
  UpdateReapJournalTarget,
  UpdateReapRecoveryPreflight,
} from "@station/contracts";
import { compareUpdateReapJournalTargets, updateReapEvidenceIsComplete } from "@station/contracts";
import type { ExactObserverOwnershipEvidence } from "@station/observer/internal";
import type { UpdateReapProcess, UpdateReapProcessGroup } from "./reapProcessGroups.js";
import type { UpdateRecoveryPreflightActionCommitments } from "./recoveryPreflight.js";

export type UpdateReapAuthorization = Readonly<{
  digest: string;
  channel: UpdateChannelId;
  selectedArtifact: UpdateArtifact;
  installedScopeDigest: string;
  host: {
    socketPath: string;
    inode: string;
    birthtimeNs: string;
    buildVersion: string;
    buildIdentity: string;
    process: Pick<UpdateReapProcess, "pid" | "startToken">;
  };
  targets: UpdateReapJournalTarget[];
}>;

export type ExactTerminalReapAuthorizationEvidence = Readonly<{
  host: UpdateReapAuthorization["host"];
  observer: unknown;
  parkedTerminals: UpdateRecoveryPreflightActionCommitments["parkedTerminals"];
  target: UpdateReapJournalTarget;
}>;

export class UpdateReapAuthorizationEvidenceError extends Error {
  override readonly name = "UpdateReapAuthorizationEvidenceError";
}

/**
 * POLICY
 *
 * Derives private SHA-256 authority for every exact Host child group and selected recovery handle.
 * Only unrelated retained sessions missing worktree evidence may remain unknown; the complete
 * original aggregate, private commitments, and targets remain bound into the digest.
 */
export function deriveUpdateReapAuthorization(input: {
  channel: UpdateChannelId;
  selectedArtifact: UpdateArtifact;
  installedScopeDigest: string;
  preflight: UpdateReapRecoveryPreflight;
  plan: UpdateConvergencePlan;
  commitments: UpdateRecoveryPreflightActionCommitments;
  hostProcess: Pick<UpdateReapProcess, "pid" | "startToken">;
  processGroups: readonly UpdateReapProcessGroup[];
}): UpdateReapAuthorization {
  if (
    input.plan.authorization !== "none" ||
    input.plan.outcome !== "reap-required" ||
    input.plan.phases.terminalConvergence.action !== "reap-required" ||
    input.preflight.boundary.authorization !== "none" ||
    !reapEvidenceIsComplete(input.preflight, input.commitments) ||
    input.preflight.host.status !== "inspected"
  ) {
    throw new UpdateReapAuthorizationEvidenceError(
      "Update reap requires one complete non-authorizing reap-required plan.",
    );
  }
  const host = requireExactHost(input.preflight, input.commitments.host);
  const liveTerminals = host.terminals.filter((terminal) => terminal.alive);
  if (
    liveTerminals.length === 0 ||
    liveTerminals.length !== input.processGroups.length ||
    new Set(liveTerminals.map((terminal) => terminal.pid)).size !== liveTerminals.length ||
    new Set(input.processGroups.map((group) => group.leader.pid)).size !==
      input.processGroups.length
  ) {
    throw new UpdateReapAuthorizationEvidenceError(
      "Update reap process-group evidence did not cover every live Host terminal.",
    );
  }
  const evidence = liveTerminals.map((terminal) =>
    deriveExactTerminalReapAuthorizationEvidence({
      preflight: input.preflight,
      commitments: input.commitments,
      hostProcess: input.hostProcess,
      processGroup: requireProcessGroup(input.processGroups, terminal.pid),
      terminalTargetId: terminal.terminalTargetId,
    }),
  );
  const targets = evidence.map((entry) => entry.target).sort(compareUpdateReapJournalTargets);
  const privateHost = evidence[0]?.host;
  if (privateHost === undefined) {
    throw new UpdateReapAuthorizationEvidenceError("Update reap did not select a live terminal.");
  }
  const observer = input.commitments.observer;
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        schemaVersion: 1,
        channel: input.channel,
        selectedArtifact: input.selectedArtifact,
        installedScopeDigest: input.installedScopeDigest,
        publicPreflight: input.preflight,
        publicPlan: input.plan,
        privatePreflightCommitments: {
          observer: observerAuthorizationIdentity(observer),
          host: {
            ...privateHost,
            terminals: host.terminals,
          },
          parkedTerminals: input.commitments.parkedTerminals,
        },
        targets,
      }),
    )
    .digest("hex");
  return {
    digest,
    channel: input.channel,
    selectedArtifact: input.selectedArtifact,
    installedScopeDigest: input.installedScopeDigest,
    host: privateHost,
    targets,
  };
}

/**
 * POLICY
 *
 * Authorizes one exact live Host-owned child process group. Update and repair both use this
 * policy, while their orchestration decides whether one or every terminal must be selected.
 */
export function deriveExactTerminalReapAuthorizationEvidence(input: {
  preflight: UpdateReapRecoveryPreflight;
  commitments: UpdateRecoveryPreflightActionCommitments;
  hostProcess: Pick<UpdateReapProcess, "pid" | "startToken">;
  processGroup: UpdateReapProcessGroup;
  terminalTargetId: string;
}): ExactTerminalReapAuthorizationEvidence {
  const host = requireExactHost(input.preflight, input.commitments.host);
  const observer = input.commitments.observer;
  if (input.preflight.observer.status === "exact" && observer?.status !== "exact") {
    throw new UpdateReapAuthorizationEvidenceError(
      "Exact Observer commitments were unavailable for terminal reap.",
    );
  }
  const terminal = host.terminals.find(
    (candidate) => candidate.alive && candidate.terminalTargetId === input.terminalTargetId,
  );
  if (terminal === undefined) {
    throw new UpdateReapAuthorizationEvidenceError("The selected terminal was not live.");
  }
  const processGroup = input.processGroup;
  if (
    processGroup.leader.pid !== terminal.pid ||
    processGroup.leader.parentPid !== input.hostProcess.pid ||
    processGroup.leader.pid !== processGroup.leader.pgid
  ) {
    throw new UpdateReapAuthorizationEvidenceError(
      "The selected terminal was not the exact Host-owned child process-group leader.",
    );
  }
  const disposition = input.preflight.terminalDispositions.find(
    (candidate) =>
      candidate.terminalTargetId === terminal.terminalTargetId &&
      candidate.ptyId === terminal.ptyId &&
      candidate.ptyInstanceId === terminal.ptyInstanceId &&
      candidate.sessionId === terminal.sessionId,
  );
  if (disposition === undefined || disposition.reapRecovery === "unknown") {
    throw new UpdateReapAuthorizationEvidenceError(
      "The selected terminal did not have a complete recovery disposition.",
    );
  }
  const selected =
    disposition.reapRecovery === "recoverable"
      ? selectedRecovery(exactRecoveryAssessment(observer), terminal.sessionId)
      : undefined;
  const target: UpdateReapJournalTarget = {
    terminal: {
      kind: terminal.kind,
      terminalTargetId: terminal.terminalTargetId,
      ptyId: terminal.ptyId,
      ptyInstanceId: terminal.ptyInstanceId,
      projectId: terminal.projectId,
      worktreeId: terminal.worktreeId,
      sessionId: terminal.sessionId,
      harnessProvider: terminal.harnessProvider,
      pid: terminal.pid,
    },
    processGroup,
    recovery:
      selected === undefined
        ? { kind: "non-resumable" }
        : {
            kind: "selected",
            projectId: selected.projectId,
            worktreeId: selected.worktreeId,
            sessionId: selected.sessionId,
            handleId: selected.handleId,
          },
  };
  return {
    host: {
      socketPath: host.endpoint.socketPath,
      inode: host.endpoint.ino.toString(),
      birthtimeNs: host.endpoint.birthtimeNs.toString(),
      buildVersion: host.health.buildVersion,
      buildIdentity: host.buildIdentity,
      process: input.hostProcess,
    },
    observer: observerAuthorizationIdentity(observer),
    parkedTerminals: input.commitments.parkedTerminals,
    target,
  };
}

function reapEvidenceIsComplete(
  preflight: UpdateReapRecoveryPreflight,
  commitments: UpdateRecoveryPreflightActionCommitments,
): boolean {
  const privateAssessment = exactRecoveryAssessment(commitments.observer);
  if (privateAssessment === undefined) return false;
  if (preflight.evidenceComplete) return updateReapEvidenceIsComplete(preflight);
  const observer = preflight.observer;
  if (
    observer.status !== "exact" ||
    observer.recovery.status !== "assessed" ||
    preflight.host.status !== "inspected" ||
    preflight.parkedBridges.status !== "assessed" ||
    preflight.parkedBridges.unownedParkedCount !== (commitments.parkedTerminals?.length ?? 0)
  )
    return false;
  const excluded = observer.recovery.assessment.sessions.filter(
    (session) => session.disposition === "unknown",
  );
  if (
    excluded.length === 0 ||
    privateAssessment.sessions.filter((session) => session.disposition === "unknown").length !==
      excluded.length
  )
    return false;
  const terminals = [...preflight.host.terminals, ...(commitments.parkedTerminals ?? [])];
  for (const session of excluded) {
    const retained = privateAssessment.sessions.find(
      (candidate) => candidate.sessionId === session.sessionId,
    );
    if (
      session.reasons.length !== 1 ||
      session.reasons[0] !== "worktree_evidence_missing" ||
      retained?.disposition !== "unknown" ||
      retained.reasons.length !== 1 ||
      retained.reasons[0] !== "worktree_evidence_missing" ||
      retained.projectId !== session.projectId ||
      retained.worktreeId !== session.worktreeId ||
      terminals.some(
        (terminal) =>
          terminal.sessionId === session.sessionId ||
          (terminal.projectId === session.projectId && terminal.worktreeId === session.worktreeId),
      )
    )
      return false;
  }
  // This projection checks the existing completeness rules; the digest keeps every original fact.
  return updateReapEvidenceIsComplete({
    ...preflight,
    observer: {
      ...observer,
      recovery: {
        status: "assessed",
        assessment: {
          ...observer.recovery.assessment,
          sessions: observer.recovery.assessment.sessions.filter(
            (session) => session.disposition !== "unknown",
          ),
        },
      },
    },
  });
}

function requireProcessGroup(
  groups: readonly UpdateReapProcessGroup[],
  pid: number,
): UpdateReapProcessGroup {
  const group = groups.find((candidate) => candidate.leader.pid === pid);
  if (group === undefined) {
    throw new UpdateReapAuthorizationEvidenceError(
      "A reap target did not have exact process-group evidence.",
    );
  }
  return group;
}

function observerAuthorizationIdentity(
  observer: ExactObserverOwnershipEvidence | undefined,
): unknown {
  if (observer?.status !== "exact") return observer;
  return {
    status: observer.status,
    health: {
      pid: observer.health.pid,
      startedAt: observer.health.startedAt,
      version: observer.health.version,
      socketPath: observer.health.socketPath,
    },
    processIdentity: observer.processIdentity,
    process: observer.process,
  };
}

export function updateReapIncumbentHostIsEmpty(
  journal: Pick<UpdateReapAuthorization, "host">,
  preflight: UpdateReapRecoveryPreflight,
  commitments: UpdateRecoveryPreflightActionCommitments,
): boolean {
  const host = commitments.host;
  return (
    preflight.host.status === "inspected" &&
    preflight.host.terminals.length === 0 &&
    host !== undefined &&
    host.terminals.length === 0 &&
    host.endpoint.socketPath === journal.host.socketPath &&
    host.endpoint.ino.toString() === journal.host.inode &&
    host.endpoint.birthtimeNs.toString() === journal.host.birthtimeNs &&
    host.health.buildVersion === journal.host.buildVersion &&
    host.buildIdentity === journal.host.buildIdentity
  );
}

function requireExactHost(
  preflight: UpdateReapRecoveryPreflight,
  host: StationHostExactEvidence | undefined,
): StationHostExactEvidence {
  if (host === undefined || preflight.host.status !== "inspected") {
    throw new UpdateReapAuthorizationEvidenceError(
      "Exact Host commitments were unavailable for update reap.",
    );
  }
  if (
    host.health.buildVersion !== preflight.host.buildVersion ||
    host.buildIdentity !== preflight.host.buildIdentity ||
    host.health.protocolVersion !== preflight.host.protocolVersion ||
    host.terminals.length !== preflight.host.terminals.length ||
    host.terminals.some((terminal, index) => {
      const projected =
        preflight.host.status === "inspected" ? preflight.host.terminals[index] : undefined;
      return (
        projected === undefined ||
        terminal.terminalTargetId !== projected.terminalTargetId ||
        terminal.ptyId !== projected.ptyId ||
        terminal.ptyInstanceId !== projected.ptyInstanceId ||
        terminal.sessionId !== projected.sessionId ||
        terminal.alive !== projected.alive ||
        terminal.pid <= 0
      );
    })
  ) {
    throw new UpdateReapAuthorizationEvidenceError(
      "Private Host commitments did not match the public preflight.",
    );
  }
  return host;
}

function exactRecoveryAssessment(
  observer: ExactObserverOwnershipEvidence | undefined,
): ObserverRecoveryAssessment | undefined {
  return observer?.status === "exact" && observer.recovery.status === "assessed"
    ? observer.recovery.assessment
    : undefined;
}

function selectedRecovery(
  assessment: ObserverRecoveryAssessment | undefined,
  sessionId: string,
): {
  projectId: string;
  worktreeId: string;
  sessionId: string;
  handleId: string;
} {
  const session = assessment?.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (
    session === undefined ||
    session.disposition !== "recoverable" ||
    session.handleResolution.kind !== "selected"
  ) {
    throw new UpdateReapAuthorizationEvidenceError(
      "A recoverable reap target lost its exact selected recovery handle.",
    );
  }
  return {
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    sessionId: session.sessionId,
    handleId: session.handleResolution.selectedHandleId,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const member = (value as Record<string, unknown>)[key];
    if (member !== undefined) output[key] = canonicalValue(member);
  }
  return output;
}
