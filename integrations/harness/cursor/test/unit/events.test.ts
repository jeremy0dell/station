import type { RawHarnessEvent } from "@station/contracts";
import { HarnessEventObservationSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { compactCursorProviderHookPayload } from "../../src/compaction";
import {
  cursorProviderHookPayloadToHarnessEventReport,
  normalizeCursorRawEvent,
  parseCursorProviderHookPayload,
} from "../../src/events";

const now = "2026-06-03T12:00:00.000Z";

describe("Cursor hook event parsing", () => {
  it("normalizes interactive Cursor session hooks through STATION identity", () => {
    const raw: RawHarnessEvent = {
      provider: "cursor",
      observedAt: now,
      event: {
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
      },
    };

    expect(parseCursorProviderHookPayload(raw.event)).toMatchObject({
      hook_event_name: "sessionStart",
      session_id: "cursor_session_123",
    });

    const observations = normalizeCursorRawEvent(raw, context());

    expect(observations).toHaveLength(1);
    expect(HarnessEventObservationSchema.parse(observations[0])).toEqual(observations[0]);
    expect(observations[0]).toMatchObject({
      provider: "cursor",
      projectId: "web",
      sessionId: "ses_web_task",
      worktreeId: "wt_web_task",
      terminalTargetId: "tmux:station:@1:%2",
      harnessRunId: "cursor:tmux:station:@1:%2",
      rawEventType: "sessionStart",
      nativeSessionId: "cursor_session_123",
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
    expect(JSON.stringify(observations[0])).not.toContain("person@example.com");
  });

  it("maps tool hooks to working without storing command payloads", () => {
    const observations = normalizeCursorRawEvent(
      {
        provider: "cursor",
        observedAt: now,
        event: {
          hook_event_name: "beforeShellExecution",
          session_id: "cursor_session_123",
          conversation_id: "conversation_123",
          workspace_roots: ["/tmp/station/web/task"],
          tool_name: "shell",
          command: "pnpm test:all",
          tool_input: { command: "pnpm test:all" },
        },
      },
      context(),
    );

    expect(observations[0]).toMatchObject({
      sessionId: "ses_web_task",
      worktreeId: "wt_web_task",
      harnessRunId: "cursor:tmux:station:@1:%2",
      rawEventType: "beforeShellExecution",
      status: {
        value: "working",
        confidence: "medium",
        reason: "Cursor is about to use shell.",
      },
      providerData: {
        toolName: "shell",
      },
    });
    expect(JSON.stringify(observations[0])).not.toContain("pnpm test:all");
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
      correlation: {
        harnessRunId: "cursor:tmux:station:@1:%2",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        nativeSessionId: "cursor_session_123",
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
    const observations = normalizeCursorRawEvent(
      {
        provider: "cursor",
        observedAt: now,
        event: {
          hook_event_name: "stop",
          status: "error",
          session_id: "cursor_session_123",
          workspace_roots: ["/tmp/station/web/task"],
        },
      },
      context(),
    );

    expect(observations[0]).toMatchObject({
      rawEventType: "stop",
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "Cursor turn ended with an error.",
      },
      providerData: {
        cursorStopStatus: "error",
      },
    });
  });

  it("maps aborted Cursor stops to medium-confidence idle", () => {
    const observations = normalizeCursorRawEvent(
      {
        provider: "cursor",
        observedAt: now,
        event: {
          hook_event_name: "stop",
          status: "aborted",
          session_id: "cursor_session_123",
          workspace_roots: ["/tmp/station/web/task"],
        },
      },
      context(),
    );

    expect(observations[0]).toMatchObject({
      rawEventType: "stop",
      status: {
        value: "idle",
        confidence: "medium",
        reason: "Cursor turn was aborted.",
      },
      providerData: {
        cursorStopStatus: "aborted",
      },
    });
  });

  it("leaves unmatched hook events uncorrelated", () => {
    const observations = normalizeCursorRawEvent(
      {
        provider: "cursor",
        observedAt: now,
        event: {
          hook_event_name: "afterAgentThought",
          session_id: "cursor_session_123",
          cwd: "/tmp/other",
        },
      },
      context(),
    );

    expect(observations[0]?.sessionId).toBeUndefined();
    expect(observations[0]?.worktreeId).toBeUndefined();
    expect(observations[0]?.harnessRunId).toBeUndefined();
  });
});

function context() {
  return {
    projects: [],
    worktrees: [
      {
        id: "wt_web_task",
        provider: "worktrunk",
        projectId: "web",
        branch: "task",
        path: "/tmp/station/web/task",
        state: "exists" as const,
        source: "worktrunk" as const,
        observedAt: now,
      },
    ],
    terminalTargets: [
      {
        id: "tmux:station:@1:%2",
        provider: "tmux",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        state: "open" as const,
        cwd: "/tmp/station/web/task",
        confidence: "high" as const,
        reason: "tmux pane has station identity binding.",
        observedAt: now,
        harnessBinding: {
          role: "main-agent",
          harnessProvider: "cursor",
        },
      },
    ],
  };
}
