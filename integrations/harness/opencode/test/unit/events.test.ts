import { HarnessEventObservationSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { compactOpenCodeHookPayload } from "../../src/compaction";
import { OpenCodeCompactEventSchema } from "../../src/eventSchemas";
import {
  normalizeOpenCodeRawEvent,
  openCodeHookPayloadToHarnessEventReport,
  parseOpenCodeCompactEvent,
} from "../../src/events";
import { openCodeForwardedEventTypes, openCodeIngressRules } from "../../src/ingressRules";

const now = "2026-05-20T12:00:00.000Z";

describe("OpenCode event parsing", () => {
  it("parses compact OpenCode events through the provider-local schema", () => {
    const event = {
      event_type: "session.status",
      cwd: "/tmp/station/web/task",
      opencode_session_id: "opencode_session_123",
      status_type: "busy",
    };

    expect(OpenCodeCompactEventSchema.parse(event)).toEqual(event);
    expect(parseOpenCodeCompactEvent(event)).toMatchObject({
      event_type: "session.status",
      status_type: "busy",
    });
  });

  it("compacts native OpenCode events and keeps heavyweight fields out of providerData", () => {
    const compaction = compactOpenCodeHookPayload({
      id: "evt_tool",
      type: "session.next.tool.called",
      cwd: "/tmp/station/web/task",
      properties: {
        sessionID: "opencode_session_123",
        callID: "call_test",
        tool: "bash",
        input: {
          command: "rm -rf /tmp/example",
        },
      },
    });

    expect(compaction.compacted).toBe(true);
    expect(compaction.payload).toMatchObject({
      event_type: "session.next.tool.called",
      opencode_session_id: "opencode_session_123",
      tool_call_id: "call_test",
      tool_name: "bash",
      property_keys: ["callID", "input", "sessionID", "tool"],
    });

    const observations = normalizeOpenCodeRawEvent(
      {
        provider: "opencode",
        observedAt: now,
        event: compaction.payload,
      },
      context(),
    );

    expect(JSON.stringify(observations[0]?.providerData)).not.toContain("rm -rf");
  });

  it("maps permission and question events to attention and working states", () => {
    expect(
      normalizeOpenCodeRawEvent(
        {
          provider: "opencode",
          observedAt: now,
          event: {
            event_type: "permission.asked",
            cwd: "/tmp/station/web/task",
            opencode_session_id: "opencode_session_123",
            tool_name: "bash",
          },
        },
        context(),
      )[0],
    ).toMatchObject({
      rawEventType: "permission.asked",
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "OpenCode requested permission for bash.",
      },
    });

    expect(
      normalizeOpenCodeRawEvent(
        {
          provider: "opencode",
          observedAt: now,
          event: {
            event_type: "question.replied",
            cwd: "/tmp/station/web/task",
            opencode_session_id: "opencode_session_123",
            question_reply: "answered",
          },
        },
        context(),
      )[0],
    ).toMatchObject({
      rawEventType: "question.replied",
      status: {
        value: "working",
        confidence: "high",
      },
    });
  });

  it("uses STATION hook context before cwd correlation and carries native session ids", () => {
    const observations = normalizeOpenCodeRawEvent(
      {
        provider: "opencode",
        observedAt: now,
        event: {
          event_type: "session.status",
          cwd: "/tmp/not-the-worktree",
          opencode_session_id: "opencode_session_123",
          status_type: "idle",
          station_project_id: "web",
          station_worktree_id: "wt_web_task",
          station_worktree_path: "/tmp/station/web/task",
          station_session_id: "ses_web_task",
          station_terminal_provider: "tmux",
          station_terminal_target_id: "tmux:station:@1:%2",
        },
      },
      context(),
    );

    expect(HarnessEventObservationSchema.parse(observations[0])).toEqual(observations[0]);
    expect(observations[0]).toMatchObject({
      provider: "opencode",
      projectId: "web",
      sessionId: "ses_web_task",
      worktreeId: "wt_web_task",
      harnessRunId: "opencode:tmux:station:@1:%2",
      terminalTargetId: "tmux:station:@1:%2",
      nativeSessionId: "opencode_session_123",
      status: {
        value: "idle",
        source: "harness_event",
      },
      providerData: {
        openCodeSessionId: "opencode_session_123",
        stationTerminalTargetId: "tmux:station:@1:%2",
      },
    });
  });

  it("turns compact plugin payloads into harness event reports", () => {
    const report = openCodeHookPayloadToHarnessEventReport({
      reportId: "report_opencode_status",
      eventType: "session.status",
      observedAt: now,
      payload: {
        event_type: "session.status",
        cwd: "/tmp/station/web/task",
        opencode_session_id: "opencode_session_123",
        status_type: "busy",
        station_worktree_id: "wt_web_task",
        station_terminal_target_id: "tmux:station:@1:%2",
      },
      diagnostics: {
        payloadBytes: 100,
        compactedBytes: 80,
        compacted: true,
        omittedFieldNames: ["properties.input"],
      },
    });

    expect(report).toMatchObject({
      provider: "opencode",
      kind: "harness",
      eventType: "session.status",
      coalesceKey: "native:opencode_session_123",
      correlation: {
        worktreeId: "wt_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        harnessRunId: "opencode:tmux:station:@1:%2",
        nativeSessionId: "opencode_session_123",
      },
      status: {
        value: "working",
      },
      diagnostics: {
        rawEventType: "session.status",
        omittedFieldNames: ["properties.input"],
      },
    });
  });

  it("marks OpenCode idle session events as completed turns", () => {
    const payload = {
      event_type: "session.status",
      cwd: "/tmp/station/web/task",
      opencode_session_id: "opencode_session_123",
      status_type: "idle",
      station_worktree_id: "wt_web_task",
      station_terminal_target_id: "tmux:station:@1:%2",
    };

    expect(
      normalizeOpenCodeRawEvent(
        {
          provider: "opencode",
          observedAt: now,
          event: payload,
        },
        context(),
      )[0],
    ).toMatchObject({
      status: {
        value: "idle",
      },
      turn: {
        kind: "turn_completed",
      },
    });

    expect(
      openCodeHookPayloadToHarnessEventReport({
        reportId: "report_opencode_idle",
        eventType: "session.status",
        observedAt: now,
        payload,
      }),
    ).toMatchObject({
      status: {
        value: "idle",
      },
      turn: {
        kind: "turn_completed",
      },
    });
  });

  it("derives OpenCode status projection coverage from provider-local ingress rules", () => {
    expect(new Set(openCodeForwardedEventTypes).size).toBe(openCodeForwardedEventTypes.length);
    expect(openCodeForwardedEventTypes).not.toContain("message.part.delta");
    expect(openCodeForwardedEventTypes).not.toContain("message.part.updated");
    expect(openCodeForwardedEventTypes).toEqual(
      expect.arrayContaining([
        "session.compacted",
        "session.next.compaction.started",
        "session.next.shell.started",
        "session.next.synthetic",
        "session.next.tool.progress",
        "session.next.tool.input.delta",
      ]),
    );

    for (const rule of openCodeIngressRules) {
      if (rule.statusIntents === undefined) continue;
      const status = normalizeOpenCodeRawEvent(
        {
          provider: "opencode",
          observedAt: now,
          event: samplePayloadForEventType(rule.eventType),
        },
        context(),
      )[0]?.status;

      expect(status, rule.eventType).toBeDefined();
    }
  });

  it("leaves non-status OpenCode telemetry as provider data without fabricating state", () => {
    const observations = normalizeOpenCodeRawEvent(
      {
        provider: "opencode",
        observedAt: now,
        event: {
          event_type: "file.edited",
          cwd: "/tmp/station/web/task",
          file_path: "/tmp/station/web/task/src/app.ts",
          opencode_session_id: "opencode_session_123",
        },
      },
      context(),
    );

    expect(observations[0]?.status).toBeUndefined();
    expect(observations[0]).toMatchObject({
      rawEventType: "file.edited",
      providerData: {
        filePath: "/tmp/station/web/task/src/app.ts",
      },
    });
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
          harnessProvider: "opencode",
          currentCommand: "opencode",
        },
      },
    ],
  };
}

function samplePayloadForEventType(eventType: string) {
  return {
    event_type: eventType,
    cwd: "/tmp/station/web/task",
    opencode_session_id: "opencode_session_123",
    status_type: "busy",
    permission_reply: "allow",
    question_reply: "answered",
    command_name: eventType === "tui.command.execute" ? "session.interrupt" : "test.command",
    tool_name: "bash",
  };
}
