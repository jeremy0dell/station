import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createHarnessEventReportIngestion } from "../../src/hooks/ingestion";
import { createInMemoryObserverPersistence } from "../support/inMemoryObserverPersistence";

const now = "2026-05-20T12:00:00.000Z";
const later = "2026-05-20T12:00:01.000Z";
const paneRunId = "cursor:tmux:station:@1:%2";

describe("harness event report ingestion recovery handles", () => {
  it.each([
    ["codex", "native-session"],
    ["claude", "native-session"],
    ["cursor", "native-session"],
    ["opencode", "native-session"],
    ["pi", "session-file"],
  ] as const)("atomically admits normalized %s %s recovery evidence", async (provider, targetKind) => {
    const clock = { now: () => new Date(now) };
    const persistence = createInMemoryObserverPersistence({ clock });
    const ingestion = createHarnessEventReportIngestion({ persistence, clock });
    const nativeValue =
      targetKind === "native-session"
        ? `${provider}-native-session`
        : `/tmp/station/web/feature/.pi/${provider}-session.jsonl`;

    await expect(
      ingestion.ingest(
        report({
          reportId: `report_${provider}_session_start`,
          observedAt: now,
          provider,
          ...(targetKind === "native-session"
            ? { nativeSessionId: nativeValue }
            : { nativeSessionFile: nativeValue }),
        }),
      ),
    ).resolves.toMatchObject({ accepted: true, status: "accepted", deduped: false });

    await expect(
      persistence.listProviderObservations({
        entityKind: "harness_event",
        referenceTime: later,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider,
        payload: expect.objectContaining({
          provider,
          eventType: "SessionStart",
          projectId: "web",
          worktreeId: "wt_web_task",
          sessionId: "ses_web_task",
          cwd: "/tmp/station/web/feature",
          ...(targetKind === "native-session"
            ? { nativeSessionId: nativeValue }
            : { nativeSessionFile: nativeValue }),
        }),
      }),
    ]);
    await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([
      expect.objectContaining({
        provider,
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        cwd: "/tmp/station/web/feature",
        target:
          targetKind === "native-session"
            ? { kind: "native-session", id: nativeValue }
            : { kind: "session-file", path: nativeValue },
      }),
    ]);
    await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual(
      targetKind === "native-session"
        ? [
            {
              provider,
              sessionId: "ses_web_task",
              nativeSessionId: nativeValue,
              state: "working",
              statusUpdatedAt: now,
            },
          ]
        : [],
    );
  });

  it.each([
    "codex",
    "claude",
    "cursor",
    "opencode",
  ] as const)("keeps %s execution and handle on the admitted native target after mismatched evidence", async (provider) => {
    const clock = { now: () => new Date(later) };
    const persistence = createInMemoryObserverPersistence({ clock });
    const ingestion = createHarnessEventReportIngestion({ persistence, clock });
    await ingestion.ingest(
      report({
        reportId: `report_${provider}_first`,
        observedAt: now,
        provider,
        nativeSessionId: `${provider}-native-first`,
      }),
    );
    await ingestion.ingest(
      report({
        reportId: `report_${provider}_mismatch`,
        observedAt: later,
        provider,
        nativeSessionId: `${provider}-native-other`,
      }),
    );

    await expect(persistence.listSessionHarnessExecutions()).resolves.toEqual([
      expect.objectContaining({ nativeSessionId: `${provider}-native-first` }),
    ]);
    await expect(persistence.listSessionRecoveryHandles()).resolves.toEqual([
      expect.objectContaining({
        target: { kind: "native-session", id: `${provider}-native-first` },
      }),
    ]);
  });

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
  provider?: "codex" | "claude" | "cursor" | "opencode" | "pi";
  nativeSessionId?: string;
  nativeSessionFile?: string;
  harnessRunId?: string;
  idle?: boolean;
}) {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: input.provider ?? "cursor",
    kind: "harness" as const,
    eventType: input.idle === true ? "stop" : "SessionStart",
    observedAt: input.observedAt,
    correlation: {
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      cwd: "/tmp/station/web/feature",
      ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }),
      ...(input.nativeSessionFile === undefined
        ? {}
        : { nativeSessionFile: input.nativeSessionFile }),
      ...(input.harnessRunId === undefined ? {} : { harnessRunId: input.harnessRunId }),
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
