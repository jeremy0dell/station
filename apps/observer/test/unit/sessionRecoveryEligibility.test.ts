import type { SessionRecoveryHandle } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  type SessionRecoveryEligibilityInput,
  type SessionRecoveryStationSession,
  sessionRecoveryEligibility,
} from "../../src/sessionRecoveryEligibility";

const now = "2026-08-20T12:00:00.000Z";
const worktreePath = "/tmp/station/web/feature";

function handle(overrides: Partial<SessionRecoveryHandle> = {}): SessionRecoveryHandle {
  return {
    id: "rec_feature",
    provider: "fake-harness",
    projectId: "web",
    worktreeId: "wt_feature",
    sessionId: "ses_feature",
    target: { kind: "native-session", id: "native_feature" },
    cwd: worktreePath,
    observedAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

function session(
  overrides: Partial<SessionRecoveryStationSession> = {},
): SessionRecoveryStationSession {
  return {
    id: "ses_feature",
    projectId: "web",
    worktreeId: "wt_feature",
    lifecycle: "open",
    harness: "fake-harness",
    createdAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

function input(
  overrides: Partial<SessionRecoveryEligibilityInput> = {},
): SessionRecoveryEligibilityInput {
  return {
    handle: handle(),
    projectId: "web",
    worktreeId: "wt_feature",
    worktreePath,
    stationSessions: [session()],
    expectedSession: { id: "ses_feature", harness: "fake-harness" },
    allowNoLocalSession: false,
    registeredHarness: { id: "fake-harness", canResume: true },
    ...overrides,
  };
}

describe("sessionRecoveryEligibility", () => {
  it("returns provider-neutral resume authority for one exact open Station session", () => {
    expect(sessionRecoveryEligibility(input())).toEqual({
      kind: "eligible",
      stationSession: session(),
      resume: {
        target: { kind: "native-session", id: "native_feature" },
        previousSessionId: "ses_feature",
        recoveryHandleId: "rec_feature",
      },
    });
  });

  it("allows an explicitly selected imported handle only when its local lifecycle row is absent", () => {
    const imported = input({
      stationSessions: [
        session({
          id: "ses_unrelated",
          lifecycle: "ended",
          endedAt: now,
        }),
      ],
      expectedSession: undefined,
      allowNoLocalSession: true,
    });
    expect(sessionRecoveryEligibility(imported)).toMatchObject({
      kind: "eligible",
      resume: { previousSessionId: "ses_feature" },
    });
    expect(sessionRecoveryEligibility({ ...imported, allowNoLocalSession: false })).toEqual({
      kind: "ineligible",
      reason: "station_session_missing",
    });
  });

  it.each([
    ["project identity", input({ handle: handle({ projectId: "other" }) }), "project_mismatch"],
    [
      "worktree identity",
      input({ handle: handle({ worktreeId: "wt_other" }) }),
      "worktree_mismatch",
    ],
    [
      "missing Station identity",
      input({ handle: handle({ sessionId: undefined }) }),
      "station_session_missing",
    ],
    [
      "different Station identity",
      input({ handle: handle({ sessionId: "ses_other" }) }),
      "station_session_mismatch",
    ],
    [
      "legacy lifecycle",
      input({ stationSessions: [session({ lifecycle: "legacy" })] }),
      "station_session_legacy",
    ],
    [
      "ended lifecycle",
      input({ stationSessions: [session({ lifecycle: "ended", endedAt: now })] }),
      "station_session_ended",
    ],
    [
      "harness identity",
      input({
        handle: handle({ provider: "other-harness" }),
        registeredHarness: { id: "other-harness", canResume: true },
      }),
      "harness_mismatch",
    ],
    ["missing provider", input({ registeredHarness: undefined }), "harness_provider_missing"],
    [
      "resume capability",
      input({ registeredHarness: { id: "fake-harness", canResume: false } }),
      "harness_resume_unsupported",
    ],
    ["missing cwd", input({ handle: handle({ cwd: undefined }) }), "cwd_missing"],
    [
      "outside cwd",
      input({ handle: handle({ cwd: "/tmp/station/other" }) }),
      "cwd_outside_worktree",
    ],
  ] as const)("rejects mismatched %s with a stable reason", (_name, policyInput, reason) => {
    expect(sessionRecoveryEligibility(policyInput)).toEqual({ kind: "ineligible", reason });
  });

  it("uses the newest open worktree session as canonical identity", () => {
    const older = session({ id: "ses_older", lastSeenAt: "2026-08-20T11:00:00.000Z" });
    const newer = session({ id: "ses_newer", lastSeenAt: "2026-08-20T13:00:00.000Z" });
    const policyInput = input({
      handle: handle({ sessionId: newer.id }),
      stationSessions: [older, newer],
      expectedSession: undefined,
    });

    expect(sessionRecoveryEligibility(policyInput)).toMatchObject({
      kind: "eligible",
      stationSession: { id: newer.id },
    });
    expect(
      sessionRecoveryEligibility({ ...policyInput, handle: handle({ sessionId: older.id }) }),
    ).toEqual({ kind: "ineligible", reason: "station_session_mismatch" });
  });
});
