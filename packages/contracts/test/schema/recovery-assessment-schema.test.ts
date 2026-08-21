import { describe, expect, it } from "vitest";
import { ObserverRecoveryAssessmentSchema } from "../../src/recoveryAssessment";

const inventory = {
  schemaVersion: 1 as const,
  sessions: [
    {
      id: "sess_a",
      projectId: "project_a",
      worktreeId: "worktree_a",
      lifecycle: "open" as const,
      harnessProvider: "codex",
      createdAt: "2026-08-21T00:00:00.000Z",
      lastSeenAt: "2026-08-21T00:01:00.000Z",
    },
  ],
  recoveryHandles: [
    {
      id: "handle_a",
      provider: "codex",
      projectId: "project_a",
      worktreeId: "worktree_a",
      sessionId: "sess_a",
      targetKind: "native-session" as const,
      observedAt: "2026-08-21T00:00:00.000Z",
      lastSeenAt: "2026-08-21T00:01:00.000Z",
    },
  ],
};

describe("ObserverRecoveryAssessmentSchema", () => {
  it("accepts one redacted assessment for every coherent inventory session", () => {
    expect(
      ObserverRecoveryAssessmentSchema.parse({
        schemaVersion: 1,
        inventory,
        resumeEnabled: true,
        sessions: [
          {
            sessionId: "sess_a",
            projectId: "project_a",
            worktreeId: "worktree_a",
            lifecycle: "open",
            harnessProvider: "codex",
            disposition: "recoverable",
            reasons: [],
            handleResolution: {
              kind: "selected",
              selectedHandleId: "handle_a",
              eligibleHandleCount: 1,
              rejectedHandleCount: 0,
              rejectedReasons: [],
            },
          },
        ],
      }),
    ).toMatchObject({ schemaVersion: 1, resumeEnabled: true });
  });

  it("rejects missing, duplicate, or unsorted session assessments", () => {
    const session = {
      sessionId: "sess_a",
      projectId: "project_a",
      worktreeId: "worktree_a",
      lifecycle: "open" as const,
      disposition: "non-resumable" as const,
      reasons: ["global_resume_disabled" as const],
      handleResolution: {
        kind: "none" as const,
        eligibleHandleCount: 0 as const,
        rejectedHandleCount: 0,
        reasons: ["no_recovery_handles" as const],
      },
    };
    expect(
      ObserverRecoveryAssessmentSchema.safeParse({
        schemaVersion: 1,
        inventory,
        resumeEnabled: false,
        sessions: [],
      }).success,
    ).toBe(false);
    expect(
      ObserverRecoveryAssessmentSchema.safeParse({
        schemaVersion: 1,
        inventory: {
          ...inventory,
          sessions: [
            ...inventory.sessions,
            {
              ...inventory.sessions[0],
              id: "sess_b",
            },
          ],
        },
        resumeEnabled: false,
        sessions: [session, session],
      }).success,
    ).toBe(false);
  });

  it("rejects unsorted reason codes and unknown fields", () => {
    expect(
      ObserverRecoveryAssessmentSchema.safeParse({
        schemaVersion: 1,
        inventory,
        resumeEnabled: false,
        sessions: [
          {
            sessionId: "sess_a",
            projectId: "project_a",
            worktreeId: "worktree_a",
            lifecycle: "open",
            disposition: "non-resumable",
            reasons: ["station_session_missing", "project_mismatch"],
            extra: "not allowed",
            handleResolution: {
              kind: "none",
              eligibleHandleCount: 0,
              rejectedHandleCount: 2,
              reasons: ["station_session_missing", "project_mismatch"],
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
