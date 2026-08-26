import { readFileSync } from "node:fs";
import { HarnessEventReportSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { compactCursorProviderHookPayload } from "../../src/compaction";
import {
  cursorProviderHookPayloadToHarnessEventReport,
  parseCursorProviderHookPayload,
} from "../../src/events";

const now = "2026-06-03T12:00:00.000Z";

describe("Cursor hook event parsing", () => {
  it("normalizes interactive Cursor session hooks through STATION identity", () => {
    const payload = {
      hook_event_name: "sessionStart",
      session_id: "cursor_session_123",
      conversation_id: "conversation_123",
      generation_id: "generation_1",
      workspace_roots: ["/tmp/station/web/task"],
      model: "cursor-model",
      cursor_version: "2026.06.02-8c11d9f",
      user_email: "person@example.com",
      station_project_id: "web",
      station_worktree_id: "wt_web_task",
      station_worktree_path: "/tmp/station/web/task",
      station_session_id: "ses_web_task",
      station_terminal_provider: "tmux",
      station_terminal_target_id: "tmux:station:@1:%2",
    };

    expect(parseCursorProviderHookPayload(payload)).toMatchObject({
      hook_event_name: "sessionStart",
      session_id: "cursor_session_123",
    });

    const report = reportForCursorPayload(payload);

    expect(HarnessEventReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      provider: "cursor",
      eventType: "sessionStart",
      correlation: {
        projectId: "web",
        sessionId: "ses_web_task",
        worktreeId: "wt_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        harnessRunId: "cursor:tmux:station:@1:%2",
        nativeSessionId: "cursor:tmux:station:@1:%2",
      },
      status: {
        value: "starting",
        confidence: "high",
        source: "harness_event",
      },
      providerData: {
        cursorSessionId: "cursor_session_123",
        cursorConversationId: "conversation_123",
        hookEventName: "sessionStart",
        cursorVersion: "2026.06.02-8c11d9f",
      },
    });
    expect(JSON.stringify(report)).not.toContain("person@example.com");
  });

  it("maps tool hooks to working without storing command payloads", () => {
    const report = reportForCursorPayload({
      hook_event_name: "beforeShellExecution",
      session_id: "cursor_session_123",
      conversation_id: "conversation_123",
      workspace_roots: ["/tmp/station/web/task"],
      tool_name: "shell",
      command: "pnpm test:all",
      tool_input: { command: "pnpm test:all" },
    });

    expect(report).toMatchObject({
      eventType: "beforeShellExecution",
      correlation: {
        nativeSessionId: "cursor_session_123",
        cwd: "/tmp/station/web/task",
      },
      status: {
        value: "working",
        confidence: "medium",
        reason: "Cursor is about to use shell.",
      },
      providerData: {
        toolName: "shell",
      },
    });
    expect(JSON.stringify(report)).not.toContain("pnpm test:all");
  });

  it("builds compact harness reports with deterministic terminal run correlation", () => {
    const compaction = compactCursorProviderHookPayload({
      hook_event_name: "stop",
      session_id: "cursor_session_123",
      conversation_id: "conversation_123",
      status: "completed",
      cwd: "/tmp/station/web/task",
      last_assistant_message: "Done.",
      station_project_id: "web",
      station_worktree_id: "wt_web_task",
      station_session_id: "ses_web_task",
      station_terminal_target_id: "tmux:station:@1:%2",
    });

    const report = cursorProviderHookPayloadToHarnessEventReport({
      reportId: "report_cursor_1",
      observedAt: now,
      payload: compaction.payload,
      diagnostics: {
        payloadBytes: compaction.originalByteCount,
        compactedBytes: compaction.compactedByteCount,
        compacted: compaction.compacted,
        truncated: false,
        omittedFieldNames: compaction.omittedFieldNames,
      },
    });

    expect(report).toMatchObject({
      provider: "cursor",
      eventType: "stop",
      status: {
        value: "idle",
        confidence: "high",
      },
      turn: { kind: "turn_completed" },
      correlation: {
        harnessRunId: "cursor:tmux:station:@1:%2",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        nativeSessionId: "cursor:tmux:station:@1:%2",
        cwd: "/tmp/station/web/task",
      },
      diagnostics: {
        rawEventType: "stop",
        compacted: true,
        omittedFieldNames: ["last_assistant_message"],
      },
      providerData: {
        cursorStopStatus: "completed",
      },
    });
    expect(JSON.stringify(report)).not.toContain("Done.");
  });

  it("maps Cursor stop errors to needs-attention instead of idle", () => {
    const report = reportForCursorPayload({
      hook_event_name: "stop",
      status: "error",
      session_id: "cursor_session_123",
      workspace_roots: ["/tmp/station/web/task"],
    });

    expect(report).toMatchObject({
      eventType: "stop",
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "Cursor turn ended with an error.",
      },
      providerData: {
        cursorStopStatus: "error",
      },
    });
    expect(report).not.toHaveProperty("turn");
  });

  it("maps aborted Cursor stops to medium-confidence idle", () => {
    const report = reportForCursorPayload({
      hook_event_name: "stop",
      status: "aborted",
      session_id: "cursor_session_123",
      workspace_roots: ["/tmp/station/web/task"],
    });

    expect(report).toMatchObject({
      eventType: "stop",
      status: {
        value: "idle",
        confidence: "medium",
        reason: "Cursor turn was aborted.",
      },
      providerData: {
        cursorStopStatus: "aborted",
      },
    });
    expect(report).not.toHaveProperty("turn");
  });

  it("leaves unmatched hook events uncorrelated", () => {
    const report = reportForCursorPayload({
      hook_event_name: "afterAgentThought",
      session_id: "cursor_session_123",
      cwd: "/tmp/other",
    });

    expect(report.correlation).toEqual({
      cwd: "/tmp/other",
      nativeSessionId: "cursor_session_123",
    });
  });

  it("unifies Station-launched Cursor native identity when hook types split session ids", () => {
    const paneNative = "cursor:native:wt_station_station-a9b1d4_7bee5c969f";
    const reports = splitNativeOneTurnReports();

    for (const report of Object.values(reports)) {
      expect(report.correlation?.nativeSessionId).toBe(paneNative);
      expect(report.correlation?.harnessRunId).toBe(paneNative);
      expect(report.correlation?.sessionId).toBe("ses_aad9521e-c580-4ec2-9591-390602578fd1");
    }

    expect(reports.beforeSubmitPrompt.providerData).toMatchObject({
      cursorSessionId: "57b2db94-a290-4e8a-b165-f8ed7e9c68f1",
      cursorConversationId: "57b2db94-a290-4e8a-b165-f8ed7e9c68f1",
      cursorGenerationId: "a2fa3d59-2a5b-4c2e-aeb5-40c6e3e1211f",
    });
    expect(reports.preToolUse.providerData).toMatchObject({
      cursorSessionId: "77af7844-ad25-40e1-8cea-e8aac8c7ad84",
      cursorConversationId: "77af7844-ad25-40e1-8cea-e8aac8c7ad84",
      cursorGenerationId: "a2fa3d59-2a5b-4c2e-aeb5-40c6e3e1211f",
      toolName: "Read",
    });
    expect(reports.stop.status.value).toBe("idle");
    expect(reports.stop.turn).toEqual({ kind: "turn_completed" });
  });
});

function reportForCursorPayload(payload: unknown) {
  return cursorProviderHookPayloadToHarnessEventReport({
    reportId: "report_cursor_test",
    observedAt: now,
    payload,
  });
}

function splitNativeOneTurnReports() {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/split-native-one-turn.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  return {
    beforeSubmitPrompt: reportForCursorPayload(fixture.beforeSubmitPrompt),
    preToolUse: reportForCursorPayload(fixture.preToolUse),
    stop: reportForCursorPayload(fixture.stop),
  };
}
