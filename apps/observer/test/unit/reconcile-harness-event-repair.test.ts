import type {
  AgentState,
  HarnessEventObservation,
  ObservedStatus,
  ProviderId,
} from "@station/contracts";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import type {
  PersistedProviderObservation,
  PersistedSessionHarnessExecution,
  PersistedSessionTurnReadiness,
} from "../../src/persistence/types";
import { ProviderRegistry } from "../../src/providers/registry";
import {
  admitPersistedHarnessEvents,
  derivedStateSupersedesRejectedEvent,
  replayAcceptedSessionState,
} from "../../src/reconcile/harnessEventRepair";

const now = "2026-06-19T12:00:00.000Z";

describe("reconcile harness event repair", () => {
  it("admits compatible events and groups rejected events by provider and session", () => {
    const compatible = persistedEvent({
      id: "obs_compatible",
      provider: "claude",
      nativeSessionId: "native_a",
      observedAt: "2026-06-19T12:00:01.000Z",
    });
    const rejected = persistedEvent({
      id: "obs_rejected",
      nativeSessionId: "native_old",
      sessionId: "session_1",
      observedAt: "2026-06-19T12:00:02.000Z",
    });
    const registry = registryWithRejectedHarness();

    const result = admitPersistedHarnessEvents(registry, [compatible, rejected]);

    expect(result.observations).toEqual([compatible]);
    expect(result.rejectedBySession).toEqual(
      new Map([
        [
          "codex\u0000session_1",
          {
            provider: "codex",
            sessionId: "session_1",
            latestStatusUpdatedAt: "2026-06-19T12:00:02.000Z",
          },
        ],
      ]),
    );
  });

  it("replays accepted lifecycle and turn-completion events into derived state", () => {
    const observations = [
      persistedEvent({
        id: "obs_working",
        sessionId: "session_1",
        nativeSessionId: "native_a",
        status: status("working", "2026-06-19T12:00:01.000Z"),
        observedAt: "2026-06-19T12:00:01.000Z",
      }),
      persistedEvent({
        id: "obs_idle",
        sessionId: "session_1",
        nativeSessionId: "native_a",
        projectId: "web",
        worktreeId: "wt_task",
        reportId: "report_1",
        turn: { kind: "turn_completed" },
        status: status("idle", "2026-06-19T12:00:02.000Z"),
        observedAt: "2026-06-19T12:00:02.000Z",
      }),
    ];

    expect(
      replayAcceptedSessionState({
        observations,
        provider: "codex",
        sessionId: "session_1",
      }),
    ).toEqual({
      harnessExecution: {
        provider: "codex",
        sessionId: "session_1",
        nativeSessionId: "native_a",
        state: "idle",
        statusUpdatedAt: "2026-06-19T12:00:02.000Z",
      },
      turnReadiness: {
        sessionId: "session_1",
        projectId: "web",
        worktreeId: "wt_task",
        token: "report_1",
        completedAt: "2026-06-19T12:00:02.000Z",
        createdAt: "2026-06-19T12:00:02.000Z",
        updatedAt: "2026-06-19T12:00:02.000Z",
      },
    });
  });

  it("does not repair derived state that is newer than the rejected event", () => {
    const binding: PersistedSessionHarnessExecution = {
      provider: "codex",
      sessionId: "session_1",
      nativeSessionId: "native_current",
      state: "working",
      statusUpdatedAt: "2026-06-19T12:00:03.000Z",
    };
    const readiness: PersistedSessionTurnReadiness = {
      sessionId: "session_1",
      projectId: "web",
      worktreeId: "wt_task",
      token: "report_2",
      completedAt: "2026-06-19T12:00:04.000Z",
      createdAt: "2026-06-19T12:00:04.000Z",
      updatedAt: "2026-06-19T12:00:04.000Z",
    };

    expect(
      derivedStateSupersedesRejectedEvent({
        binding,
        readiness,
        rejectedAt: "2026-06-19T12:00:02.000Z",
      }),
    ).toBe(true);
    expect(
      derivedStateSupersedesRejectedEvent({
        binding,
        readiness,
        rejectedAt: "2026-06-19T12:00:04.000Z",
      }),
    ).toBe(false);
  });
});

function registryWithRejectedHarness(): ProviderRegistry {
  const harness = Object.create(
    new FakeHarnessProvider({ id: "codex", now }),
  ) as FakeHarnessProvider;
  harness.acceptsPersistedEvent = () => false;
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({ now, worktrees: [] }),
    terminal: new FakeTerminalProvider({ now }),
    harnesses: [harness],
  });
}

function persistedEvent(input: {
  id: string;
  provider?: ProviderId;
  sessionId?: string;
  nativeSessionId?: string;
  projectId?: string;
  worktreeId?: string;
  reportId?: string;
  turn?: { kind: "turn_completed" };
  status?: ObservedStatus;
  observedAt?: string;
}): PersistedProviderObservation {
  const provider = input.provider ?? "codex";
  const observedAt = input.observedAt ?? now;
  const payload: HarnessEventObservation = {
    provider,
    observedAt,
  };
  if (input.sessionId !== undefined) payload.sessionId = input.sessionId;
  if (input.nativeSessionId !== undefined) payload.nativeSessionId = input.nativeSessionId;
  if (input.projectId !== undefined) payload.projectId = input.projectId;
  if (input.worktreeId !== undefined) payload.worktreeId = input.worktreeId;
  if (input.reportId !== undefined) payload.reportId = input.reportId;
  if (input.turn !== undefined) payload.turn = input.turn;
  if (input.status !== undefined) payload.status = input.status;
  return {
    id: input.id,
    provider,
    providerType: "harness",
    entityKind: "harness_event",
    entityKey: input.sessionId ?? input.id,
    payload,
    observedAt,
    expired: false,
  };
}

function status(value: AgentState, updatedAt: string): ObservedStatus {
  return {
    value,
    confidence: "high",
    reason: value,
    source: "harness_event",
    updatedAt,
  };
}
