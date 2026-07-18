import type { AgentState, ObservedStatus } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  decideSessionHarnessExecution,
  type SessionHarnessExecutionDecision,
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

  it("allows a new native execution only after explicit idle or exited evidence", () => {
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

  it("rejects mismatched activity while the owner is active, stuck, unknown, or newer", () => {
    const activeA = binding(decide(undefined, evidence("native_a", status("working", t1))));
    const idleA = binding(decide(activeA, evidence("native_a", status("idle", t2))));

    for (const state of ["starting", "working", "needs_attention", "stuck", "unknown"] as const) {
      const blocked = decide({ ...idleA, state }, evidence("native_b", status("working", t3)));
      expect(blocked).toEqual({ mayDeriveState: false });
    }

    const delayedB = decide(idleA, evidence("native_b", status("working", t1)));
    expect(delayedB).toEqual({ mayDeriveState: false });
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
