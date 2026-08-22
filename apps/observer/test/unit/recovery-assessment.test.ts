import type { SessionRecoveryHandle, StationSnapshot } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { FakeHarnessProvider } from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import type { PersistedSession } from "../../src/persistence/types";
import {
  assessObserverRecovery,
  inspectObserverRecoveryAssessment,
} from "../../src/sessionRecoveryAssessment";

const earlier = "2026-08-20T11:00:00.000Z";
const now = "2026-08-20T12:00:00.000Z";

describe("inspectObserverRecoveryAssessment", () => {
  it("reads persistence once and uses exact eligibility plus newest-eligible selection", async () => {
    const readRecoveryInventory = vi.fn(async () => ({
      sessions: [session()],
      recoveryHandles: [
        handle({
          id: "handle-new-rejected",
          lastSeenAt: "2026-08-20T13:00:00.000Z",
          cwd: "/elsewhere",
        }),
        handle({ id: "handle-old", lastSeenAt: earlier }),
        handle({ id: "handle-new", lastSeenAt: now }),
      ],
    }));

    const result = await inspectObserverRecoveryAssessment({
      graph: graph(true),
      persistence: { readRecoveryInventory },
      providers: providers(true),
      config: enabledConfig(),
    });

    expect(readRecoveryInventory).toHaveBeenCalledOnce();
    expect(result.providerCapabilities).toEqual([{ provider: "codex", status: "enabled" }]);
    expect(result.sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        disposition: "recoverable",
        reasons: [],
        handleResolution: {
          kind: "selected",
          selectedHandleId: "handle-new",
          eligibleHandleCount: 2,
          rejectedHandleCount: 1,
          rejectedReasons: ["cwd_outside_worktree"],
        },
      }),
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/private/worktree");
    expect(serialized).not.toContain("/elsewhere");
    expect(serialized).not.toContain("provider-native-secret");
  });

  it("returns typed unknown when the captured graph lacks exact worktree evidence", () => {
    const result = assessObserverRecovery({
      graph: graph(false),
      persistenceSnapshot: { sessions: [session()], recoveryHandles: [handle()] },
      providers: providers(true),
      config: enabledConfig(),
    });

    expect(result.sessions[0]).toMatchObject({
      disposition: "unknown",
      reasons: ["worktree_evidence_missing"],
      handleResolution: { kind: "unknown", reasons: ["worktree_evidence_missing"] },
    });
  });

  it.each([
    {
      name: "global resume disabled",
      config: { featureFlags: { sessionResumeAgent: false }, harness: { codex: { resume: true } } },
      canResume: true,
      expected: ["global_resume_disabled"],
    },
    {
      name: "provider resume disabled",
      config: { featureFlags: { sessionResumeAgent: true }, harness: { codex: { resume: false } } },
      canResume: false,
      expected: ["harness_resume_unsupported", "provider_resume_disabled"],
    },
    {
      name: "provider resume unsupported",
      config: { featureFlags: { sessionResumeAgent: true }, harness: { codex: { resume: true } } },
      canResume: false,
      expected: ["harness_resume_unsupported"],
    },
  ])("normalizes $name without provider-specific payload parsing", ({
    config,
    canResume,
    expected,
  }) => {
    const result = assessObserverRecovery({
      graph: graph(true),
      persistenceSnapshot: { sessions: [session()], recoveryHandles: [handle()] },
      providers: providers(canResume),
      config,
    });

    expect(result.sessions[0]).toMatchObject({
      disposition: "non-resumable",
      reasons: expected,
    });
  });

  it("assigns deterministic dispositions to ended and handle-less retained sessions", () => {
    const result = assessObserverRecovery({
      graph: graph(true),
      persistenceSnapshot: {
        sessions: [
          session({ id: "session-ended", lifecycle: "ended", endedAt: now }),
          session({ id: "session-open" }),
        ],
        recoveryHandles: [],
      },
      providers: providers(true),
      config: enabledConfig(),
    });

    expect(result.sessions).toMatchObject([
      {
        sessionId: "session-ended",
        disposition: "not-applicable",
        reasons: ["station_session_ended"],
      },
      {
        sessionId: "session-open",
        disposition: "non-resumable",
        reasons: ["no_recovery_handles"],
      },
    ]);
  });
});

function session(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id: "session-a",
    projectId: "project-a",
    worktreeId: "worktree-a",
    lifecycle: "open",
    harness: "codex",
    createdAt: earlier,
    lastSeenAt: now,
    ...overrides,
  };
}

function handle(overrides: Partial<SessionRecoveryHandle> = {}): SessionRecoveryHandle {
  return {
    id: "handle-a",
    provider: "codex",
    projectId: "project-a",
    worktreeId: "worktree-a",
    sessionId: "session-a",
    target: { kind: "native-session", id: "provider-native-secret" },
    cwd: "/private/worktree/task",
    observedAt: earlier,
    lastSeenAt: now,
    ...overrides,
  };
}

function providers(canResume: boolean) {
  const provider = new FakeHarnessProvider({ id: "codex", capabilities: { canResume } });
  return { harnesses: new Map([[provider.id, provider]]) };
}

function enabledConfig() {
  return {
    featureFlags: { sessionResumeAgent: true },
    harness: { codex: { resume: true } },
  };
}

function graph(includeWorktree: boolean): StationSnapshot {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    generatedAt: now,
    observer: { pid: 123, startedAt: earlier, version: "test", healthy: true },
    providerHealth: {},
    projects: [],
    rows: includeWorktree
      ? [
          {
            id: "worktree-a",
            projectId: "project-a",
            projectLabel: "private project",
            title: "private title",
            branch: "private-branch",
            path: "/private/worktree",
            worktree: { state: "exists", source: "station" },
            display: { statusLabel: "no agent", sortPriority: 0, alert: false },
          },
        ]
      : [],
    sessions: [],
    sessionGroups: [],
    counts: {
      projects: 0,
      sessions: 0,
      worktrees: includeWorktree ? 1 : 0,
      agents: 0,
      working: 0,
      idle: 0,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  };
}
