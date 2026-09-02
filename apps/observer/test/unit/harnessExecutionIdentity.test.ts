import { readFileSync } from "node:fs";
import type { AgentState, ObservedStatus } from "@station/contracts";
import { cursorProviderHookPayloadToHarnessEventReport } from "@station/cursor";
import { describe, expect, it } from "vitest";
import {
  decideSessionHarnessExecution,
  type SessionHarnessExecutionDecision,
  sessionHarnessExecutionEvidenceFromReport,
} from "../../src/harnessExecutionIdentity";
import type {
  PersistedSessionHarnessExecution,
  SessionHarnessExecutionEvidence,
} from "../../src/persistence";

const t1 = "2026-05-21T12:00:01.000Z";
const t2 = "2026-05-21T12:00:02.000Z";
const t3 = "2026-05-21T12:00:03.000Z";

describe("session harness execution identity", () => {
  it("keeps arrival-bound native A authoritative over delayed activity and completion from B", () => {
    const bound = decide(undefined, evidence("native_a", status("working", t2)));
    expect(bound).toMatchObject({
      mayDeriveState: true,
      binding: { nativeSessionId: "native_a", state: "working" },
    });

    const delayedB = decide(binding(bound), evidence("native_b", status("working", t1)));
    expect(delayedB).toEqual({ mayDeriveState: false });

    const stopB = decide(binding(bound), evidence("native_b", status("idle", t3)));
    expect(stopB).toEqual({ mayDeriveState: false });
  });

  it("fails closed for identityless or stale evidence after a native execution is bound", () => {
    const current = binding(decide(undefined, evidence("native_a", status("working", t2))));
    const identityless = decide(current, {
      provider: "codex",
      sessionId: "ses_1",
      status: status("idle", t3),
    });
    expect(identityless).toEqual({ mayDeriveState: false });

    const staleA = decide(current, evidence("native_a", status("idle", t1)));
    expect(staleA).toEqual({ mayDeriveState: false });
  });

  it("allows ordinary native replacement after explicit idle or exited evidence", () => {
    const activeA = binding(decide(undefined, evidence("native_a", status("working", t1))));

    for (const replaceableState of ["idle", "exited"] as const) {
      const replaceableA = binding(
        decide(activeA, evidence("native_a", status(replaceableState, t2))),
      );
      const activeB = decide(replaceableA, evidence("native_b", status("working", t3)));
      expect(activeB).toMatchObject({
        mayDeriveState: true,
        binding: { nativeSessionId: "native_b", state: "working" },
      });
    }
  });

  it("promotes corroborated activity over a different provisional startup", () => {
    const provisionalA = binding(decide(undefined, evidence("native_a", status("starting", t1))));

    for (const insufficientState of ["starting", "idle", "exited"] as const) {
      expect(decide(provisionalA, evidence("native_b", status(insufficientState, t2)))).toEqual({
        mayDeriveState: false,
      });
    }
    expect(
      decide(provisionalA, evidence("native_b", status("working", "2026-05-21T12:00:00.000Z"))),
    ).toEqual({ mayDeriveState: false });

    for (const corroboratedState of ["working", "needs_attention"] as const) {
      expect(
        decide(provisionalA, evidence("native_b", status(corroboratedState, t2))),
      ).toMatchObject({
        mayDeriveState: true,
        binding: { nativeSessionId: "native_b", state: corroboratedState },
      });
    }
  });

  it("rejects mismatched activity while the owner is active, stuck, unknown, or newer", () => {
    const activeA = binding(decide(undefined, evidence("native_a", status("working", t1))));
    const idleA = binding(decide(activeA, evidence("native_a", status("idle", t2))));

    for (const state of ["working", "needs_attention", "stuck", "unknown"] as const) {
      const blocked = decide({ ...idleA, state }, evidence("native_b", status("working", t3)));
      expect(blocked).toEqual({ mayDeriveState: false });
    }

    const delayedB = decide(idleA, evidence("native_b", status("working", t1)));
    expect(delayedB).toEqual({ mayDeriveState: false });
  });

  it("lets pane-scoped Cursor stop idle a conversation-scoped tool-runner binding", () => {
    const paneId = "cursor:native:wt_station_station-a9b1d4_7bee5c969f";
    const bound = {
      provider: "cursor" as const,
      sessionId: "ses_aad9521e-c580-4ec2-9591-390602578fd1",
      nativeSessionId: "77af7844-ad25-40e1-8cea-e8aac8c7ad84",
      state: "working" as const,
      statusUpdatedAt: "2026-08-26T19:39:46.208Z",
    };
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../../integrations/harness/cursor/test/fixtures/split-native-one-turn.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const stop = cursorProviderHookPayloadToHarnessEventReport({
      reportId: "hook_census_stop",
      observedAt: "2026-08-26T19:40:10.000Z",
      payload: fixture.stop,
    });
    const decision = decideSessionHarnessExecution({
      current: bound,
      evidence: sessionHarnessExecutionEvidenceFromReport(stop),
    });

    expect(stop.correlation?.nativeSessionId).toBe(paneId);
    expect(decision).toMatchObject({
      mayDeriveState: true,
      binding: { nativeSessionId: paneId, state: "idle" },
    });
  });
});

function decide(
  current: PersistedSessionHarnessExecution | undefined,
  executionEvidence: SessionHarnessExecutionEvidence,
): SessionHarnessExecutionDecision {
  return decideSessionHarnessExecution({ current, evidence: executionEvidence });
}

function binding(decision: SessionHarnessExecutionDecision): PersistedSessionHarnessExecution {
  if (decision.binding === undefined) throw new Error("Expected an execution binding.");
  return decision.binding;
}

function evidence(
  nativeSessionId: string,
  executionStatus: ObservedStatus,
): SessionHarnessExecutionEvidence {
  return {
    provider: "codex",
    sessionId: "ses_1",
    nativeSessionId,
    status: executionStatus,
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
