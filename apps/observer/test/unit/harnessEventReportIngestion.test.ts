import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createHarnessEventReportIngestion } from "../../src/hooks/ingestion";
import { createInMemoryObserverPersistence } from "../support/inMemoryObserverPersistence";

const now = "2026-05-20T12:00:00.000Z";
const later = "2026-05-20T12:00:01.000Z";
const paneRunId = "cursor:tmux:station:@1:%2";

describe("harness event report ingestion recovery handles", () => {
  it("does not mint a native-session handle from pane-scoped native identity", async () => {
    const clock = { now: () => new Date(now) };
    const persistence = createInMemoryObserverPersistence({ clock });
    const ingestion = createHarnessEventReportIngestion({ persistence, clock });

    await ingestion.ingest(
      report({
        reportId: "report_conversation_working",
        observedAt: now,
        nativeSessionId: "77af7844-ad25-40e1-8cea-e8aac8c7ad84",
        harnessRunId: paneRunId,
      }),
    );
    await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([
      expect.objectContaining({
        target: { kind: "native-session", id: "77af7844-ad25-40e1-8cea-e8aac8c7ad84" },
      }),
    ]);

    await ingestion.ingest(
      report({
        reportId: "report_pane_stop",
        observedAt: later,
        nativeSessionId: paneRunId,
        harnessRunId: paneRunId,
        idle: true,
      }),
    );
    await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([
      expect.objectContaining({
        target: { kind: "native-session", id: "77af7844-ad25-40e1-8cea-e8aac8c7ad84" },
      }),
    ]);
  });
});

function report(input: {
  reportId: string;
  observedAt: string;
  nativeSessionId: string;
  harnessRunId: string;
  idle?: boolean;
}) {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "cursor",
    kind: "harness" as const,
    eventType: input.idle === true ? "stop" : "preToolUse",
    observedAt: input.observedAt,
    correlation: {
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      nativeSessionId: input.nativeSessionId,
      harnessRunId: input.harnessRunId,
    },
    status: {
      value: input.idle === true ? ("idle" as const) : ("working" as const),
      confidence: "high" as const,
      reason: input.idle === true ? "Cursor turn completed." : "Cursor is about to use Read.",
      source: "harness_event" as const,
      updatedAt: input.observedAt,
    },
  };
}
