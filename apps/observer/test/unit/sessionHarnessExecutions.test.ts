import type { AgentState, ObservedStatus, ProviderId } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  applySessionHarnessExecutionEvidence,
  getSessionHarnessExecution,
  listSessionHarnessExecutions,
} from "../../src/persistence/sessionHarnessExecutions";
import type { SessionHarnessExecutionEvidence } from "../../src/persistence/types";
import { openObserverSqlite } from "../../src/sqlite";

describe("session harness execution store", () => {
  it("persists only authorized native execution lifecycle advances", () => {
    const sqlite = openObserverSqlite();

    try {
      expect(
        applySessionHarnessExecutionEvidence(
          sqlite.database,
          evidence("codex", "ses_1", "native_b", "idle", "2026-07-14T12:00:00.000Z"),
        ),
      ).toBe(false);
      expect(
        applySessionHarnessExecutionEvidence(sqlite.database, {
          provider: "codex",
          nativeSessionId: "native_external",
          status: status("working", "2026-07-14T12:00:00.500Z"),
        }),
      ).toBe(true);
      expect(listSessionHarnessExecutions(sqlite.database)).toEqual([]);

      expect(
        applySessionHarnessExecutionEvidence(
          sqlite.database,
          evidence("codex", "ses_1", "native_a", "working", "2026-07-14T12:00:01.000Z"),
        ),
      ).toBe(true);
      expect(
        getSessionHarnessExecution(sqlite.database, { provider: "codex", sessionId: "ses_1" }),
      ).toEqual({
        provider: "codex",
        sessionId: "ses_1",
        nativeSessionId: "native_a",
        state: "working",
        statusUpdatedAt: "2026-07-14T12:00:01.000Z",
      });

      expect(
        applySessionHarnessExecutionEvidence(
          sqlite.database,
          evidence("codex", "ses_1", "native_b", "idle", "2026-07-14T12:00:02.000Z"),
        ),
      ).toBe(false);
      expect(
        getSessionHarnessExecution(sqlite.database, { provider: "codex", sessionId: "ses_1" }),
      ).toMatchObject({ nativeSessionId: "native_a", state: "working" });

      expect(
        applySessionHarnessExecutionEvidence(
          sqlite.database,
          evidence("codex", "ses_1", "native_a", "idle", "2026-07-14T12:00:03.000Z"),
        ),
      ).toBe(true);
      expect(
        applySessionHarnessExecutionEvidence(sqlite.database, {
          provider: "codex",
          nativeSessionId: "native_b",
          status: status("working", "2026-07-14T12:00:04.000Z"),
        }),
      ).toBe(true);
      expect(
        getSessionHarnessExecution(sqlite.database, { provider: "codex", sessionId: "ses_1" }),
      ).toMatchObject({ nativeSessionId: "native_a", state: "idle" });

      expect(
        applySessionHarnessExecutionEvidence(
          sqlite.database,
          evidence("codex", "ses_1", "native_a", "working", "2026-07-14T12:00:05.000Z"),
        ),
      ).toBe(true);
      expect(
        getSessionHarnessExecution(sqlite.database, { provider: "codex", sessionId: "ses_1" }),
      ).toMatchObject({ nativeSessionId: "native_a", state: "working" });

      expect(
        applySessionHarnessExecutionEvidence(
          sqlite.database,
          evidence("codex", "ses_1", "native_a", "exited", "2026-07-14T12:00:06.000Z"),
        ),
      ).toBe(true);
      expect(
        applySessionHarnessExecutionEvidence(
          sqlite.database,
          evidence("codex", "ses_1", "native_c", "working", "2026-07-14T12:00:07.000Z"),
        ),
      ).toBe(true);
      expect(
        getSessionHarnessExecution(sqlite.database, { provider: "codex", sessionId: "ses_1" }),
      ).toEqual({
        provider: "codex",
        sessionId: "ses_1",
        nativeSessionId: "native_c",
        state: "working",
        statusUpdatedAt: "2026-07-14T12:00:07.000Z",
      });
    } finally {
      sqlite.close();
    }
  });

  it("isolates bindings by provider and lists them deterministically", () => {
    const sqlite = openObserverSqlite();

    try {
      for (const input of [
        evidence("codex", "ses_b", "codex_b", "working", "2026-07-14T12:00:01.000Z"),
        evidence("claude", "ses_shared", "claude_a", "working", "2026-07-14T12:00:02.000Z"),
        evidence("codex", "ses_shared", "codex_a", "working", "2026-07-14T12:00:03.000Z"),
      ]) {
        expect(applySessionHarnessExecutionEvidence(sqlite.database, input)).toBe(true);
      }

      expect(
        getSessionHarnessExecution(sqlite.database, {
          provider: "cursor",
          sessionId: "ses_shared",
        }),
      ).toBeUndefined();
      expect(listSessionHarnessExecutions(sqlite.database)).toEqual([
        {
          provider: "claude",
          sessionId: "ses_shared",
          nativeSessionId: "claude_a",
          state: "working",
          statusUpdatedAt: "2026-07-14T12:00:02.000Z",
        },
        {
          provider: "codex",
          sessionId: "ses_b",
          nativeSessionId: "codex_b",
          state: "working",
          statusUpdatedAt: "2026-07-14T12:00:01.000Z",
        },
        {
          provider: "codex",
          sessionId: "ses_shared",
          nativeSessionId: "codex_a",
          state: "working",
          statusUpdatedAt: "2026-07-14T12:00:03.000Z",
        },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

function evidence(
  provider: ProviderId,
  sessionId: string,
  nativeSessionId: string,
  state: AgentState,
  updatedAt: string,
): SessionHarnessExecutionEvidence {
  return {
    provider,
    sessionId,
    nativeSessionId,
    status: status(state, updatedAt),
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
