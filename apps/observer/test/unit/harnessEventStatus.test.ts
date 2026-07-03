import type {
  AgentState,
  Confidence,
  HarnessEventObservation,
  HarnessRunObservation,
  ObservedStatus,
} from "@station/contracts";
import { describe, expect, it } from "vitest";
import type { PersistedProviderObservation } from "../../src/persistence";
import {
  applyHarnessEventStatusOverlays,
  decayStaleBusyStatuses,
  type ObserverHarnessRun,
  observerHarnessRunFromRun,
} from "../../src/reconcile/harnessEventStatus";

const runObservedAt = "2026-05-21T12:00:00.000Z";
const eventObservedAt = "2026-05-21T12:00:01.000Z";

describe("harness event status overlays", () => {
  it("promotes a correlated Codex activity event over terminal-only unknown status", () => {
    const result = overlay({
      runs: [run()],
      observations: [
        observation({
          harnessRunId: "run_1",
          rawEventType: "PreToolUse",
          status: status("working", "medium", "Codex is about to use Bash."),
        }),
      ],
    });

    expect(result[0]?.run).toMatchObject({
      state: "working",
      confidence: "medium",
      reason: "Codex is about to use Bash.",
      observedAt: runObservedAt,
    });
    expect(result[0]?.run.providerData).toBeUndefined();
    expect(result[0]?.status).toMatchObject({
      value: "working",
      source: "harness_event",
      updatedAt: eventObservedAt,
    });
  });

  it("promotes permission and stop events to attention and idle", () => {
    const attention = overlay({
      runs: [run()],
      observations: [
        observation({
          harnessRunId: "run_1",
          rawEventType: "PermissionRequest",
          status: status("needs_attention", "high", "Codex requested permission for Bash."),
        }),
      ],
    });
    const idle = overlay({
      runs: [run()],
      observations: [
        observation({
          harnessRunId: "run_1",
          rawEventType: "Stop",
          status: status("idle", "high", "Codex turn completed."),
        }),
      ],
    });

    expect(attention[0]?.run.state).toBe("needs_attention");
    expect(attention[0]?.status.value).toBe("needs_attention");
    expect(idle[0]?.run.state).toBe("idle");
    expect(idle[0]?.status.value).toBe("idle");
  });

  it("does not let unknown, invalid, or wrong-provider events clobber live state", () => {
    const result = overlay({
      runs: [run({ state: "working", confidence: "high", reason: "Live process is active." })],
      observations: [
        observation({
          harnessRunId: "run_1",
          status: status("unknown", "low", "No useful hook status."),
        }),
        invalidObservation(),
        observation(
          {
            harnessRunId: "run_1",
            status: status("needs_attention", "high", "Wrong persisted provider."),
          },
          { provider: "opencode" },
        ),
      ],
    });

    expect(result[0]?.run).toMatchObject({
      state: "working",
      confidence: "high",
      reason: "Live process is active.",
    });
  });

  it("ignores unmatched or ambiguous events", () => {
    const unmatched = overlay({
      runs: [run()],
      observations: [
        observation({
          harnessRunId: "missing_run",
          worktreeId: "wt_1",
          sessionId: "ses_1",
          status: status("working", "medium", "This should not fall back."),
        }),
      ],
    });
    const ambiguous = overlay({
      runs: [run(), run({ id: "run_2", worktreeId: "wt_2", sessionId: "ses_1" })],
      observations: [
        observation({
          sessionId: "ses_1",
          status: status("needs_attention", "high", "Ambiguous session."),
        }),
      ],
    });

    expect(unmatched[0]?.run.state).toBe("unknown");
    expect(ambiguous.map((entry) => entry.run.state)).toEqual(["unknown", "unknown"]);
  });

  it("uses worktree-only correlation only when exactly one live run exists", () => {
    const single = overlay({
      runs: [run()],
      observations: [
        observation({
          harnessRunId: undefined,
          sessionId: undefined,
          worktreeId: "wt_1",
          status: status("working", "medium", "Unique worktree match."),
        }),
      ],
    });
    const multiple = overlay({
      runs: [run(), run({ id: "run_2", sessionId: "ses_2" })],
      observations: [
        observation({
          harnessRunId: undefined,
          sessionId: undefined,
          worktreeId: "wt_1",
          status: status("working", "medium", "Ambiguous worktree match."),
        }),
      ],
    });

    expect(single[0]?.run.state).toBe("working");
    expect(single[0]?.run.providerData).toBeUndefined();
    expect(multiple.map((entry) => entry.run.state)).toEqual(["unknown", "unknown"]);
  });

  it("does not overwrite a newer high-confidence exited live state with older hook activity", () => {
    const result = overlay({
      runs: [
        run({
          state: "exited",
          confidence: "high",
          reason: "Harness process exited.",
          observedAt: "2026-05-21T12:00:10.000Z",
        }),
      ],
      observations: [
        observation({
          harnessRunId: "run_1",
          observedAt: "2026-05-21T12:00:05.000Z",
          status: status("working", "medium", "Older tool event.", "2026-05-21T12:00:05.000Z"),
        }),
      ],
    });

    expect(result[0]?.run).toMatchObject({
      state: "exited",
      confidence: "high",
      reason: "Harness process exited.",
    });
  });
});

describe("stale busy status decay", () => {
  // runObservedAt + 15 minutes exactly, and one millisecond past it.
  const atWindow = "2026-05-21T12:15:00.000Z";
  const pastWindow = "2026-05-21T12:15:00.001Z";

  it("decays a working run with no signals past the window to unknown", () => {
    const result = decayStaleBusyStatuses({
      runs: [run({ state: "working", confidence: "high", reason: "Codex is running Bash." })],
      now: pastWindow,
    });

    expect(result[0]?.status).toMatchObject({
      value: "unknown",
      confidence: "low",
      source: "reconcile",
      updatedAt: runObservedAt,
    });
    expect(result[0]?.status.reason).toContain(runObservedAt);
    expect(result[0]?.run).toMatchObject({ state: "unknown", confidence: "low" });
  });

  it("decays a starting run the same way", () => {
    const result = decayStaleBusyStatuses({
      runs: [run({ state: "starting", reason: "Codex is starting." })],
      now: pastWindow,
    });

    expect(result[0]?.status.value).toBe("unknown");
  });

  it("keeps a busy status at or inside the window", () => {
    const result = decayStaleBusyStatuses({
      runs: [run({ state: "working", reason: "Codex is running Bash." })],
      now: atWindow,
    });

    expect(result[0]?.status.value).toBe("working");
  });

  it("never decays attention, idle, exited, or unknown statuses", () => {
    for (const state of ["needs_attention", "idle", "exited", "unknown"] as const) {
      const result = decayStaleBusyStatuses({
        runs: [run({ state, reason: "State under test." })],
        now: "2026-05-28T12:00:00.000Z",
      });

      expect(result[0]?.status.value).toBe(state);
    }
  });

  it("decays overlaid event statuses and is stable across repeated reconciles", () => {
    const overlaid = overlay({
      runs: [run()],
      observations: [
        observation({
          harnessRunId: "run_1",
          rawEventType: "UserPromptSubmit",
          status: status("working", "medium", "Prompt submitted."),
        }),
      ],
    });

    const once = decayStaleBusyStatuses({ runs: overlaid, now: "2026-05-21T13:00:00.000Z" });
    const twice = decayStaleBusyStatuses({ runs: once, now: "2026-05-21T14:00:00.000Z" });

    expect(once[0]?.status).toMatchObject({ value: "unknown", updatedAt: eventObservedAt });
    expect(twice).toEqual(once);
  });

  it("leaves unparseable status timestamps alone", () => {
    const result = decayStaleBusyStatuses({
      runs: [run({ state: "working", reason: "Bad clock.", observedAt: "not-a-timestamp" })],
      now: pastWindow,
    });

    expect(result[0]?.status.value).toBe("working");
  });
});

function overlay(input: {
  runs: ObserverHarnessRun[];
  observations: PersistedProviderObservation[];
}): ObserverHarnessRun[] {
  return applyHarnessEventStatusOverlays(input);
}

function run(input: Partial<HarnessRunObservation> = {}): ObserverHarnessRun {
  const state = input.state ?? "unknown";
  const confidence = input.confidence ?? "low";
  const runObservation: HarnessRunObservation = {
    id: input.id ?? "run_1",
    provider: input.provider ?? "codex",
    projectId: input.projectId ?? "web",
    worktreeId: input.worktreeId ?? "wt_1",
    sessionId: input.sessionId ?? "ses_1",
    state,
    confidence,
    reason: input.reason ?? "tmux target is bound to Codex.",
    observedAt: input.observedAt ?? runObservedAt,
  };
  if (input.pid !== undefined) runObservation.pid = input.pid;
  if (input.cwd !== undefined) runObservation.cwd = input.cwd;
  if (input.providerData !== undefined) runObservation.providerData = input.providerData;
  return observerHarnessRunFromRun(runObservation);
}

function status(
  value: AgentState,
  confidence: Confidence,
  reason: string,
  updatedAt = eventObservedAt,
): ObservedStatus {
  return {
    value,
    confidence,
    reason,
    source: "harness_event",
    updatedAt,
  };
}

function observation(
  input: {
    status: ObservedStatus;
    harnessRunId?: string | undefined;
    sessionId?: string | undefined;
    worktreeId?: string | undefined;
    rawEventType?: string;
    observedAt?: string;
  },
  overrides: { provider?: string } = {},
): PersistedProviderObservation {
  const provider = overrides.provider ?? "codex";
  const payload: HarnessEventObservation = {
    provider,
    status: input.status,
    observedAt: input.observedAt ?? input.status.updatedAt,
  };
  if (input.harnessRunId !== undefined) payload.harnessRunId = input.harnessRunId;
  if (input.sessionId !== undefined) payload.sessionId = input.sessionId;
  if (input.worktreeId !== undefined) payload.worktreeId = input.worktreeId;
  if (input.rawEventType !== undefined) payload.rawEventType = input.rawEventType;

  return persistedObservation(payload, {
    provider,
    observedAt: input.observedAt ?? payload.observedAt,
  });
}

function invalidObservation(): PersistedProviderObservation {
  return {
    id: "obs_invalid",
    provider: "codex",
    providerType: "harness",
    entityKind: "harness_event",
    entityKey: "run_1",
    payload: {
      provider: "codex",
      status: {
        value: "definitely-not-a-state",
      },
      observedAt: eventObservedAt,
    },
    observedAt: eventObservedAt,
    expired: false,
  };
}

function persistedObservation(
  payload: HarnessEventObservation,
  input: {
    provider: string;
    observedAt: string;
  },
): PersistedProviderObservation {
  return {
    id: `obs_${input.provider}_${input.observedAt}_${payload.rawEventType ?? "event"}`,
    provider: input.provider,
    providerType: "harness",
    entityKind: "harness_event",
    entityKey: payload.harnessRunId ?? payload.sessionId ?? payload.worktreeId ?? "event",
    payload,
    observedAt: input.observedAt,
    expired: false,
  };
}
