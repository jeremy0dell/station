import type {
  AgentState,
  HarnessEventObservation,
  HarnessRunObservation,
} from "@station/contracts";
import { describe, expect, it } from "vitest";
import type {
  PersistedProviderObservation,
  PersistedSessionHarnessExecution,
} from "../../src/persistence/types";
import { supersededWorkingHarnessEventIds } from "../../src/reconcile/harnessEventCompaction";
import { replayAcceptedSessionState } from "../../src/reconcile/harnessEventRepair";
import {
  applyHarnessEventStatusOverlays,
  synthesizeExternalHarnessRuns,
} from "../../src/reconcile/harnessEventStatus";

const base = Date.parse("2026-06-19T12:00:00.000Z");

describe("superseded working harness events", () => {
  it("selects a working event repeated by the next event of the same session", () => {
    const observations = [
      event({ id: "a1", status: "working", native: "a", at: 1 }),
      event({ id: "other", session: "session_2", status: "working", native: "b", at: 2 }),
      event({ id: "a2", status: "working", native: "a", at: 3 }),
      event({ id: "a3", status: "working", native: "a", at: 4 }),
    ];

    expect(supersededWorkingHarnessEventIds(observations)).toEqual(["a1", "a2"]);
  });

  it("keeps working events separated by another event, identity, or an older status time", () => {
    const observations = [
      event({ id: "a1", status: "working", native: "a", at: 1 }),
      event({ id: "idle", status: "idle", native: "a", at: 2 }),
      event({ id: "a2", status: "working", native: "a", at: 3 }),
      event({ id: "b1", status: "working", native: "b", at: 4 }),
      event({ id: "b2", status: "working", native: "b", at: 6 }),
      event({ id: "b3", status: "working", native: "b", at: 7, updatedAt: 5 }),
    ];

    expect(supersededWorkingHarnessEventIds(observations)).toEqual(["b1"]);
  });

  it("selects repeated external working events by native identity", () => {
    const observations = [
      event({ id: "x1", session: undefined, status: "working", native: "x", at: 1 }),
      event({ id: "y1", session: undefined, status: "working", native: "y", at: 2 }),
      event({ id: "x2", session: undefined, status: "working", native: "x", at: 3 }),
    ];

    expect(supersededWorkingHarnessEventIds(observations)).toEqual(["x1"]);
  });

  it("leaves replay, status overlays, and external runs unchanged for every short history", () => {
    const steps: { status: AgentState; native: string }[] = [
      { status: "working", native: "a" },
      { status: "working", native: "b" },
      { status: "idle", native: "a" },
      { status: "needs_attention", native: "b" },
    ];
    const initialBindings: (PersistedSessionHarnessExecution | undefined)[] = [
      undefined,
      binding("a", "starting", 0),
      binding("b", "starting", 0),
      binding("b", "working", 0),
    ];
    const runs: HarnessRunObservation[] = [run("run_1", "session_1", "a")];
    let comparedHistories = 0;

    for (const history of histories(steps, 4)) {
      const compactedIds = new Set(supersededWorkingHarnessEventIds(history));
      const compacted = history.filter((observation) => !compactedIds.has(observation.id));
      for (const initialHarnessExecution of initialBindings) {
        const replayInput = { provider: "codex", sessionId: "session_1" };
        const withInitial = (observations: PersistedProviderObservation[]) =>
          initialHarnessExecution === undefined
            ? { ...replayInput, observations }
            : { ...replayInput, observations, initialHarnessExecution };
        expect(replayAcceptedSessionState(withInitial(compacted))).toEqual(
          replayAcceptedSessionState(withInitial(history)),
        );
      }
      expect(applyHarnessEventStatusOverlays({ runs, observations: compacted })).toEqual(
        applyHarnessEventStatusOverlays({ runs, observations: history }),
      );
      const external = history.map((observation) => withoutSession(observation));
      const externalIds = new Set(supersededWorkingHarnessEventIds(external));
      expect(
        synthesizeExternalHarnessRuns({
          runs: [],
          observations: external.filter((observation) => !externalIds.has(observation.id)),
        }),
      ).toEqual(synthesizeExternalHarnessRuns({ runs: [], observations: external }));
      comparedHistories += 1;
    }

    expect(comparedHistories).toBeGreaterThan(10_000);
  }, 60_000);
});

// Every sequence of up to `maxLength` steps, with each status time moving back, staying, or advancing.
function* histories(
  steps: readonly { status: AgentState; native: string }[],
  maxLength: number,
): Generator<PersistedProviderObservation[]> {
  function* extend(
    prefix: PersistedProviderObservation[],
    updatedAt: number,
  ): Generator<PersistedProviderObservation[]> {
    if (prefix.length > 0) yield prefix;
    if (prefix.length === maxLength) return;
    for (const step of steps) {
      for (const delta of [-1, 0, 1]) {
        const at = prefix.length + 1;
        const next = event({
          id: `e${at}`,
          status: step.status,
          native: step.native,
          at,
          updatedAt: updatedAt + delta,
        });
        yield* extend([...prefix, next], updatedAt + delta);
      }
    }
  }
  yield* extend([], 1);
}

function event(input: {
  id: string;
  session?: string | undefined;
  status: AgentState;
  native: string;
  at: number;
  updatedAt?: number;
}): PersistedProviderObservation {
  const observedAt = timestamp(input.at);
  const payload: HarnessEventObservation = {
    provider: "codex",
    reportId: `report_${input.id}`,
    nativeSessionId: input.native,
    projectId: "web",
    worktreeId: "wt_task",
    status: {
      value: input.status,
      confidence: "high",
      reason: `${input.status} ${input.id}`,
      source: "harness_event",
      updatedAt: timestamp(input.updatedAt ?? input.at),
    },
    observedAt,
  };
  const session = "session" in input ? input.session : "session_1";
  if (session !== undefined) payload.sessionId = session;
  return {
    id: input.id,
    provider: "codex",
    providerType: "harness",
    entityKind: "harness_event",
    entityKey: input.id,
    payload,
    observedAt,
    expired: false,
  };
}

function withoutSession(observation: PersistedProviderObservation): PersistedProviderObservation {
  if (observation.entityKind !== "harness_event") return observation;
  const { sessionId: _sessionId, ...payload } = observation.payload;
  return { ...observation, payload };
}

function binding(
  native: string,
  state: AgentState,
  updatedAt: number,
): PersistedSessionHarnessExecution {
  return {
    provider: "codex",
    sessionId: "session_1",
    nativeSessionId: native,
    state,
    statusUpdatedAt: timestamp(updatedAt),
  };
}

function run(id: string, sessionId: string, native: string): HarnessRunObservation {
  return {
    id,
    provider: "codex",
    sessionId,
    worktreeId: "wt_task",
    nativeSessionId: native,
    status: {
      value: "unknown",
      confidence: "low",
      reason: "discovered",
      source: "provider",
      updatedAt: timestamp(0),
    },
    observedAt: timestamp(0),
  };
}

function timestamp(seconds: number): string {
  return new Date(base + seconds * 1000).toISOString();
}
