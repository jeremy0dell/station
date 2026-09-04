import type { HarnessResumeOptions, SessionRecoveryHandle } from "@station/contracts";
import { pathIsSameOrInside } from "@station/runtime";

export type SessionRecoveryStationSession = {
  id: string;
  projectId: string;
  worktreeId: string;
  lifecycle: "legacy" | "open" | "ended";
  harness?: string;
  endedAt?: string;
  createdAt: string;
  lastSeenAt: string;
};

export type SessionRecoveryEligibilityReason =
  | "project_mismatch"
  | "worktree_mismatch"
  | "station_session_missing"
  | "station_session_mismatch"
  | "station_session_legacy"
  | "station_session_ended"
  | "harness_mismatch"
  | "harness_provider_missing"
  | "harness_resume_unsupported"
  | "cwd_missing"
  | "cwd_outside_worktree";

export type SessionRecoveryEligibility =
  | {
      kind: "eligible";
      resume: HarnessResumeOptions;
      stationSession?: SessionRecoveryStationSession;
    }
  | { kind: "ineligible"; reason: SessionRecoveryEligibilityReason };

export type SessionRecoveryEligibilityInput = {
  handle: SessionRecoveryHandle;
  projectId: string;
  worktreeId: string;
  worktreePath: string;
  stationSessions: readonly SessionRecoveryStationSession[];
  expectedSession?: { id: string; harness: string };
  allowNoLocalSession: boolean;
  registeredHarness?: { id: string; canResume: boolean };
};

/**
 * POLICY
 *
 * Admits one opaque recovery handle only when its provider-neutral identity, open Station
 * lifecycle, registered harness capability, and cwd evidence authorize the exact worktree.
 * A deliberately selected imported handle may proceed without a local lifecycle row when the handle
 * itself matches any expected identity. Local legacy, ended, or contradictory identity always wins.
 */
export function sessionRecoveryEligibility(
  input: SessionRecoveryEligibilityInput,
): SessionRecoveryEligibility {
  const handle = input.handle;
  if (handle.projectId !== input.projectId) {
    return { kind: "ineligible", reason: "project_mismatch" };
  }
  if (handle.worktreeId !== input.worktreeId) {
    return { kind: "ineligible", reason: "worktree_mismatch" };
  }
  if (handle.sessionId === undefined) {
    return { kind: "ineligible", reason: "station_session_missing" };
  }
  const registeredHarness = input.registeredHarness;
  if (registeredHarness === undefined || registeredHarness.id !== handle.provider) {
    return { kind: "ineligible", reason: "harness_provider_missing" };
  }
  if (!registeredHarness.canResume) {
    return { kind: "ineligible", reason: "harness_resume_unsupported" };
  }
  if (input.expectedSession !== undefined && handle.sessionId !== input.expectedSession.id) {
    return { kind: "ineligible", reason: "station_session_mismatch" };
  }
  if (input.expectedSession !== undefined && handle.provider !== input.expectedSession.harness) {
    return { kind: "ineligible", reason: "harness_mismatch" };
  }

  const stationSession = sessionForRecovery(input);
  if (stationSession === undefined) {
    if (!input.allowNoLocalSession) {
      return { kind: "ineligible", reason: "station_session_missing" };
    }
  } else {
    if (
      stationSession.projectId !== input.projectId ||
      stationSession.worktreeId !== input.worktreeId ||
      handle.sessionId !== stationSession.id
    ) {
      return { kind: "ineligible", reason: "station_session_mismatch" };
    }
    if (stationSession.lifecycle === "ended" || stationSession.endedAt !== undefined) {
      return { kind: "ineligible", reason: "station_session_ended" };
    }
    if (stationSession.lifecycle !== "open") {
      return { kind: "ineligible", reason: "station_session_legacy" };
    }
    if (
      stationSession.harness === undefined ||
      handle.provider !== stationSession.harness ||
      (input.expectedSession !== undefined &&
        stationSession.harness !== input.expectedSession.harness)
    ) {
      return { kind: "ineligible", reason: "harness_mismatch" };
    }
  }

  if (handle.cwd === undefined) {
    return { kind: "ineligible", reason: "cwd_missing" };
  }
  if (!pathIsSameOrInside(handle.cwd, input.worktreePath)) {
    return { kind: "ineligible", reason: "cwd_outside_worktree" };
  }

  const resume: HarnessResumeOptions = {
    target: handle.target,
    recoveryHandleId: handle.id,
  };
  resume.previousSessionId = handle.sessionId;
  return {
    kind: "eligible",
    resume,
    ...(stationSession === undefined ? {} : { stationSession }),
  };
}

function sessionForRecovery(
  input: SessionRecoveryEligibilityInput,
): SessionRecoveryStationSession | undefined {
  if (input.expectedSession !== undefined) {
    const expectedSessionId = input.expectedSession.id;
    return input.stationSessions.find((session) => session.id === expectedSessionId);
  }

  const worktreeSessions = input.stationSessions.filter(
    (session) => session.projectId === input.projectId && session.worktreeId === input.worktreeId,
  );
  const canonicalOpenSession = worktreeSessions
    .filter(
      (session) =>
        session.lifecycle === "open" &&
        session.endedAt === undefined &&
        session.harness !== undefined,
    )
    .sort(compareSessionRecency)[0];
  if (canonicalOpenSession !== undefined) {
    return canonicalOpenSession;
  }

  if (input.handle.sessionId !== undefined) {
    const boundSessionId = input.handle.sessionId;
    return input.stationSessions.find((session) => session.id === boundSessionId);
  }
  return undefined;
}

function compareSessionRecency(
  left: SessionRecoveryStationSession,
  right: SessionRecoveryStationSession,
): number {
  return (
    Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}
