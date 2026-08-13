import type { ProviderHookEvent } from "@station/contracts";
import { HarnessEventReportSchema, STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { compactOpenCodeHookPayload } from "../../src/compaction";
import { OpenCodeCompactEventSchema } from "../../src/eventSchemas";
import {
  openCodeHookPayloadToHarnessEventReport,
  parseOpenCodeCompactEvent,
} from "../../src/events";
import { openCodeHookAdapter } from "../../src/hookAdapter";
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

    const report = reportForOpenCodePayload(compaction.payload);

    expect(JSON.stringify(report.providerData)).not.toContain("rm -rf");
  });

  it("maps permission and question events to attention and working states", () => {
    expect(
      reportForOpenCodePayload({
        event_type: "permission.asked",
        cwd: "/tmp/station/web/task",
        opencode_session_id: "opencode_session_123",
        tool_name: "bash",
      }),
    ).toMatchObject({
      eventType: "permission.asked",
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "OpenCode requested permission for bash.",
      },
    });

    expect(
      reportForOpenCodePayload({
        event_type: "question.replied",
        cwd: "/tmp/station/web/task",
        opencode_session_id: "opencode_session_123",
        question_reply: "answered",
      }),
    ).toMatchObject({
      eventType: "question.replied",
      status: {
        value: "working",
        confidence: "high",
      },
    });
  });

  it("carries explicit STATION and native identity into the report", () => {
    const report = reportForOpenCodePayload({
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
    });

    expect(HarnessEventReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      provider: "opencode",
      correlation: {
        projectId: "web",
        sessionId: "ses_web_task",
        worktreeId: "wt_web_task",
        harnessRunId: "opencode:tmux:station:@1:%2",
        terminalTargetId: "tmux:station:@1:%2",
        nativeSessionId: "opencode_session_123",
      },
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

  it("keeps status-idle as idle without marking a completed turn", () => {
    const payload = {
      event_type: "session.status",
      cwd: "/tmp/station/web/task",
      opencode_session_id: "opencode_session_123",
      status_type: "idle",
      station_worktree_id: "wt_web_task",
      station_terminal_target_id: "tmux:station:@1:%2",
    };

    const report = reportForOpenCodePayload(payload);
    expect(report).toMatchObject({
      status: {
        value: "idle",
      },
    });
    expect(report).not.toHaveProperty("turn");
  });

  it("marks OpenCode session.idle events as completed turns", () => {
    const payload = {
      event_type: "session.idle",
      cwd: "/tmp/station/web/task",
      opencode_session_id: "opencode_session_123",
      station_worktree_id: "wt_web_task",
      station_terminal_target_id: "tmux:station:@1:%2",
    };

    expect(reportForOpenCodePayload(payload)).toMatchObject({
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
      const status = reportForOpenCodePayload(samplePayloadForEventType(rule.eventType)).status;

      expect(status, rule.eventType).toBeDefined();
    }
  });

  it("leaves non-status OpenCode telemetry as provider data without fabricating state", () => {
    const report = reportForOpenCodePayload({
      event_type: "file.edited",
      cwd: "/tmp/station/web/task",
      file_path: "/tmp/station/web/task/src/app.ts",
      opencode_session_id: "opencode_session_123",
    });

    expect(report.status).toBeUndefined();
    expect(report).toMatchObject({
      eventType: "file.edited",
      providerData: {
        filePath: "/tmp/station/web/task/src/app.ts",
      },
    });
  });

  it("enriches and scopes forwarded OpenCode hooks with Station identity", () => {
    const baseEvent: ProviderHookEvent = {
      schemaVersion: STATION_SCHEMA_VERSION,
      provider: "opencode",
      kind: "harness",
      event: "session.idle",
      receivedAt: now,
    };

    expect(
      openCodeHookAdapter.enrichPayload?.({
        payload: {
          event_type: "session.idle",
          cwd: "/tmp/station/web/task",
        },
        env: {
          STATION_SESSION_ID: "ses_web_task",
          STATION_WORKTREE_ID: "wt_web_task",
          STATION_WORKTREE_MANAGED_ROOT: "/tmp/station/web/task",
        },
      }),
    ).toMatchObject({
      station_session_id: "ses_web_task",
      station_worktree_id: "wt_web_task",
      station_worktree_managed_root: "/tmp/station/web/task",
    });
    expect(
      openCodeHookAdapter.decideScope?.({
        ...baseEvent,
        payload: {
          station_session_id: "ses_web_task",
          station_worktree_id: "wt_web_task",
        },
      }),
    ).toEqual({ action: "accept", reason: "station-env" });
    expect(
      openCodeHookAdapter.decideScope?.({
        ...baseEvent,
        event: "message.part.delta",
        payload: {
          station_session_id: "ses_web_task",
          station_worktree_id: "wt_web_task",
        },
      }),
    ).toEqual({ action: "ignore", reason: "event-not-forwarded" });
    expect(
      openCodeHookAdapter.decideScope?.({
        ...baseEvent,
        payload: {
          station_worktree_id: "wt_web_task",
        },
      }),
    ).toEqual({ action: "ignore", reason: "missing-station-env" });
  });

  it("converts OpenCode hook envelopes to reports with provider observation time", () => {
    const observedAt = "2026-05-20T11:59:59.000Z";
    const hookEvent: ProviderHookEvent = {
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_opencode_idle",
      provider: "opencode",
      kind: "harness",
      event: "session.idle",
      receivedAt: now,
      payload: {
        event_type: "session.idle",
        observed_at: observedAt,
        cwd: "/tmp/station/web/task",
        opencode_session_id: "opencode_session_123",
        station_worktree_id: "wt_web_task",
        station_worktree_managed_root: "/tmp/station/web/task",
        station_session_id: "ses_web_task",
        station_terminal_target_id: "tmux:station:@1:%2",
      },
    };
    const compacted = openCodeHookAdapter.compactPayload?.(hookEvent);
    if (compacted === undefined) {
      throw new Error("OpenCode hook payload compaction was not registered.");
    }
    const result = openCodeHookAdapter.toHarnessEventReport?.({
      event: compacted.event,
      payloadSummary: compacted.payloadSummary,
      fallbackReportId: () => "fallback_report_id",
    });
    if (result === undefined || !result.ok) {
      throw new Error("OpenCode hook report mapping failed.");
    }

    expect(result.report).toMatchObject({
      reportId: "hook_opencode_idle",
      provider: "opencode",
      kind: "harness",
      eventType: "session.idle",
      observedAt,
      status: {
        value: "idle",
      },
      turn: {
        kind: "turn_completed",
      },
      correlation: {
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        nativeSessionId: "opencode_session_123",
      },
      diagnostics: {
        rawEventType: "session.idle",
        compacted: false,
      },
    });
  });
});

function reportForOpenCodePayload(payload: unknown) {
  const eventType = parseOpenCodeCompactEvent(payload).event_type;
  return openCodeHookPayloadToHarnessEventReport({
    reportId: "report_opencode_test",
    eventType,
    observedAt: now,
    payload,
  });
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
