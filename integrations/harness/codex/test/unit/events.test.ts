import type { HarnessEventReport, ObservedStatus } from "@station/contracts";
import {
  HarnessEventObservationSchema,
  HarnessEventReportSchema,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import { describe, expect, it } from "vitest";
import { codexAppServerEventToHarnessEventObservation } from "../../src/appServer/observations";
import { compactCodexHookPayload } from "../../src/compaction";
import { CodexHarnessProviderError } from "../../src/errors";
import {
  acceptsCodexPersistedEvent,
  type CodexHookEvent,
  CodexHookEventSchema,
  codexHookPayloadReportId,
  codexHookPayloadToHarnessEventReport,
  parseCodexHookEvent,
} from "../../src/events";
import { codexHookAdapter } from "../../src/hookAdapter";
import { codexForwardedEventTypes, codexIngressRules } from "../../src/ingressRules";

const now = "2026-05-21T12:00:00.000Z";

describe("Codex hook event parsing", () => {
  it("derives a unique forwarded event set that excludes delayed SubagentStop", () => {
    const subagentStop = {
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task",
      hook_event_name: "SubagentStop",
      model: "gpt-5.4-codex",
      turn_id: "turn_1",
      agent_transcript_path: null,
      agent_id: "agent_1",
      agent_type: "reviewer",
      stop_hook_active: false,
      last_assistant_message: null,
    };

    expect(codexIngressRules).toEqual([
      {
        provider: "codex",
        eventType: "SessionStart",
        statusIntents: ["starting"],
        confidences: ["high"],
      },
      {
        provider: "codex",
        eventType: "UserPromptSubmit",
        statusIntents: ["working"],
        confidences: ["medium"],
      },
      {
        provider: "codex",
        eventType: "PreToolUse",
        statusIntents: ["working", "needs_attention"],
        confidences: ["medium", "high"],
      },
      {
        provider: "codex",
        eventType: "PermissionRequest",
        statusIntents: ["working", "needs_attention"],
        confidences: ["medium", "high"],
      },
      {
        provider: "codex",
        eventType: "PostToolUse",
        statusIntents: ["working"],
        confidences: ["medium", "high"],
      },
      {
        provider: "codex",
        eventType: "PreCompact",
        statusIntents: ["working"],
        confidences: ["medium"],
      },
      {
        provider: "codex",
        eventType: "PostCompact",
        statusIntents: ["working"],
        confidences: ["medium"],
      },
      {
        provider: "codex",
        eventType: "SubagentStart",
        statusIntents: ["working"],
        confidences: ["medium"],
      },
      {
        provider: "codex",
        eventType: "Stop",
        statusIntents: ["idle", "working"],
        confidences: ["high", "medium"],
      },
    ]);
    expect(new Set(codexForwardedEventTypes).size).toBe(codexIngressRules.length);
    expect(codexForwardedEventTypes).not.toContain("SubagentStop");
    expect(codexIngressRules.find((rule) => rule.eventType === "SubagentStop")).toBeUndefined();
    expect(new Set(codexForwardedEventTypes)).toEqual(new Set(Object.keys(CODEX_HOOK_FIXTURES)));
    expect(CodexHookEventSchema.safeParse(subagentStop).success).toBe(false);
    expect(
      codexHookAdapter.decideScope?.({
        schemaVersion: STATION_SCHEMA_VERSION,
        provider: "codex",
        kind: "harness",
        event: "SubagentStop",
        receivedAt: now,
        payload: subagentStop,
      }),
    ).toEqual({ action: "ignore", reason: "event-not-forwarded" });
    expect(() => parseCodexHookEvent(subagentStop)).toThrowError(CodexHarnessProviderError);
    expect(() =>
      codexHookPayloadToHarnessEventReport({
        reportId: "report_subagent_stop",
        observedAt: now,
        payload: subagentStop,
      }),
    ).toThrowError(CodexHarnessProviderError);
  });

  it("strictly parses documented SessionStart events and normalizes them", () => {
    const payload = {
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task",
      hook_event_name: "SessionStart",
      model: "gpt-5.4-codex",
      permission_mode: "default",
      source: "startup",
    };

    expect(parseCodexHookEvent(payload)).toMatchObject({
      hook_event_name: "SessionStart",
      source: "startup",
    });

    const report = reportForCodexPayload(payload);

    expect(HarnessEventReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      provider: "codex",
      eventType: "SessionStart",
      correlation: {
        cwd: "/tmp/station/web/task",
        nativeSessionId: "codex_session_123",
      },
      status: {
        value: "starting",
        confidence: "high",
        source: "harness_event",
      },
      providerData: {
        codexSessionId: "codex_session_123",
        hookEventName: "SessionStart",
      },
    });
  });

  it("maps PermissionRequest to needs_attention without leaking tool input", () => {
    const report = reportForCodexPayload({
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task",
      hook_event_name: "PermissionRequest",
      model: "gpt-5.4-codex",
      permission_mode: "default",
      turn_id: "turn_1",
      tool_name: "Bash",
      tool_input: {
        command: "rm -rf /tmp/example",
        description: "Delete temp files",
      },
    });

    expect(report).toMatchObject({
      eventType: "PermissionRequest",
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "Codex requested permission for Bash.",
        attention: "tool_approval",
      },
    });
    expect(JSON.stringify(report.providerData)).not.toContain("rm -rf");
  });

  it("keeps auto-reviewed PermissionRequest events working after compaction", () => {
    const compacted = compactCodexHookPayload({
      session_id: "codex_session_123",
      transcript_path: "/tmp/codex-rollout.jsonl",
      cwd: "/tmp/station/web/task",
      hook_event_name: "PermissionRequest",
      model: "gpt-5.6-sol",
      permission_mode: "default",
      turn_id: "turn_1",
      tool_name: "Bash",
      tool_input: { command: "pnpm test:all" },
      station_codex_permission_reviewer_evidence: {
        status: "resolved",
        source: "transcript_turn_context",
        reviewer: "auto_review",
      },
    });

    const report = reportForCodexPayload(compacted.payload);

    expect(report).toMatchObject({
      eventType: "PermissionRequest",
      status: {
        value: "working",
        confidence: "medium",
        reason: "Codex routed permission for Bash to automatic review.",
      },
      providerData: {
        permissionReviewerEvidence: {
          status: "resolved",
          reviewer: "auto_review",
        },
      },
    });
    expect(report.status).not.toHaveProperty("attention");
    expectStatusAllowedByCodexIngressRule("PermissionRequest", report.status);
  });

  it("keeps explicit user review and unavailable reviewer evidence as attention", () => {
    const permissionPayload = (permissionReviewerEvidence: Record<string, string>) => ({
      session_id: "codex_session_123",
      transcript_path: "/tmp/codex-rollout.jsonl",
      cwd: "/tmp/station/web/task",
      hook_event_name: "PermissionRequest" as const,
      model: "gpt-5.6-sol",
      permission_mode: "default" as const,
      turn_id: "turn_1",
      tool_name: "Bash",
      tool_input: { command: "pnpm test:all" },
      station_codex_permission_reviewer_evidence: permissionReviewerEvidence,
    });

    const userReview = reportForCodexPayload(
      permissionPayload({
        status: "resolved",
        source: "transcript_turn_context",
        reviewer: "user",
      }),
    );
    const unavailable = reportForCodexPayload(
      permissionPayload({
        status: "unavailable",
        source: "transcript_turn_context",
        reason: "turn_context_not_found",
      }),
    );

    for (const report of [userReview, unavailable]) {
      expect(report.status).toMatchObject({
        value: "needs_attention",
        confidence: "high",
        attention: "tool_approval",
      });
      expectStatusAllowedByCodexIngressRule("PermissionRequest", report.status);
    }
  });

  it("maps request_user_input tool hooks to an attention question and back", () => {
    const hookEvent = (hookEventName: "PreToolUse" | "PostToolUse") => ({
      provider: "codex" as const,
      observedAt: now,
      event: {
        session_id: "codex_session_123",
        transcript_path: null,
        cwd: "/tmp/station/web/task",
        hook_event_name: hookEventName,
        model: "gpt-5.4-codex",
        permission_mode: "default",
        turn_id: "turn_1",
        tool_name: "request_user_input",
        tool_input: { questions: [] },
        tool_use_id: "call_probe_1",
        ...(hookEventName === "PostToolUse" ? { tool_response: { answers: {} } } : {}),
      },
    });

    const opened = reportForCodexPayload(hookEvent("PreToolUse").event);
    expect(opened).toMatchObject({
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "Codex requested user input.",
        attention: "question",
      },
    });
    expectStatusAllowedByCodexIngressRule("PreToolUse", opened.status);

    const resolved = reportForCodexPayload(hookEvent("PostToolUse").event);
    expect(resolved).toMatchObject({
      status: {
        value: "working",
        confidence: "high",
        reason: "Codex received user input.",
      },
    });
    expect(resolved.status?.attention).toBeUndefined();
    expectStatusAllowedByCodexIngressRule("PostToolUse", resolved.status);
  });

  it("normalizes Codex app-server input requests through its native event path", () => {
    const observations = codexAppServerEventToHarnessEventObservation(
      {
        method: "item/tool/requestUserInput",
        id: 7,
        params: {
          threadId: "thr_input",
          turnId: "turn_1",
          itemId: "item_tool_1",
          questions: [],
        },
      },
      { observedAt: now },
    );

    expect(observations).toHaveLength(1);
    expect(HarnessEventObservationSchema.parse(observations[0])).toEqual(observations[0]);
    expect(observations[0]).toMatchObject({
      provider: "codex",
      rawEventType: "item/tool/requestUserInput",
      harnessRunId: "codex:app-server:thr_input",
      nativeSessionId: "thr_input",
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "Codex requested user input.",
        attention: "question",
      },
      providerData: {
        transport: "app-server",
        appServerMethod: "item/tool/requestUserInput",
        requestId: 7,
      },
    });
  });

  it("distinguishes repeated PermissionRequest reports in the same turn", () => {
    const payload = {
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task",
      hook_event_name: "PermissionRequest",
      model: "gpt-5.4-codex",
      permission_mode: "default",
      turn_id: "turn_1",
      tool_name: "Bash",
      tool_input: {
        compacted: true,
        originalBytes: 256,
      },
    };
    const firstAt = "2026-05-21T12:00:00.000Z";
    const secondAt = "2026-05-21T12:00:01.000Z";

    const firstId = codexHookPayloadReportId(payload, firstAt);
    const secondId = codexHookPayloadReportId(payload, secondAt);
    const report = codexHookPayloadToHarnessEventReport({
      reportId: firstId,
      observedAt: firstAt,
      payload,
    });

    expect(firstId).toBe(
      "codex:codex_session_123:PermissionRequest:turn_1:tool%3ABash:request%3A2026-05-21T12%3A00%3A00.000Z",
    );
    expect(secondId).not.toBe(firstId);
    expect(report.coalesceKey).toBe(`report:${firstId}`);
  });

  it("retains STATION hook identity when cwd is the stamped worktree or a descendant", () => {
    const payload = {
      ...CODEX_HOOK_FIXTURES.PreToolUse,
      cwd: "/tmp/station/web/task/src",
    };
    const report = codexHookPayloadToHarnessEventReport({
      reportId: "report_descendant_cwd",
      observedAt: now,
      payload,
    });

    expect(report.status).toMatchObject({ value: "working" });
    expect(report.correlation).toMatchObject({
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      terminalTargetId: "tmux:station:@1:%2",
      nativeSessionId: "codex_session_123",
      cwd: "/tmp/station/web/task/src",
    });
    expect(report.diagnostics?.correlationIssue).toBeUndefined();
  });

  it("withholds inherited STATION identity across a nested managed-worktree boundary", () => {
    const payload = {
      ...CODEX_HOOK_FIXTURES.PreToolUse,
      cwd: "/tmp/station/web/.worktrees/feature/src",
      station_worktree_path: "/tmp/station/web",
      station_worktree_managed_root: "/tmp/station/web/.worktrees",
    };
    const compacted = compactCodexHookPayload(payload);
    const report = codexHookPayloadToHarnessEventReport({
      reportId: "report_nested_managed_worktree",
      observedAt: now,
      payload: compacted.payload,
    });

    expect(report.correlation).toEqual({
      nativeSessionId: "codex_session_123",
      cwd: "/tmp/station/web/.worktrees/feature/src",
    });
    expect(report.diagnostics).toMatchObject({
      correlationIssue: "station_identity_cwd_mismatch",
    });
    expect(report.providerData).toMatchObject({
      stationWorktreePath: "/tmp/station/web",
      stationWorktreeManagedRoot: "/tmp/station/web/.worktrees",
    });
  });

  it("withholds inherited STATION identity when cwd contradicts the stamped worktree", () => {
    const payload = {
      ...CODEX_HOOK_FIXTURES.PreToolUse,
      cwd: "/tmp/codex-home/.codex/memories",
    };
    const report = codexHookPayloadToHarnessEventReport({
      reportId: "report_mismatched_cwd",
      observedAt: now,
      payload,
    });

    expect(report.correlation).toEqual({
      nativeSessionId: "codex_session_123",
      cwd: "/tmp/codex-home/.codex/memories",
    });
    expect(report.diagnostics).toMatchObject({
      rawEventType: "PreToolUse",
      correlationIssue: "station_identity_cwd_mismatch",
    });
    expect(report.providerData).toMatchObject({
      cwd: "/tmp/codex-home/.codex/memories",
      stationWorktreePath: "/tmp/station/web/task",
      stationSessionId: "ses_web_task",
    });
  });

  it("keeps legacy STATION hook identity when no stamped worktree path is available", () => {
    const { station_worktree_path: _omitted, ...payload } = {
      ...CODEX_HOOK_FIXTURES.PreToolUse,
      cwd: "/tmp/not-the-worktree",
    };
    const report = codexHookPayloadToHarnessEventReport({
      reportId: "report_without_stamped_path",
      observedAt: now,
      payload,
    });

    expect(report.correlation).toMatchObject({
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      terminalTargetId: "tmux:station:@1:%2",
      nativeSessionId: "codex_session_123",
      cwd: "/tmp/not-the-worktree",
    });
    expect(report.diagnostics?.correlationIssue).toBeUndefined();
  });

  it("rejects only recognizable persisted Codex hook observations with contradictory paths", () => {
    const valid = observationForCodexReport(reportForCodexPayload(CODEX_HOOK_FIXTURES.PreToolUse));
    const mismatched = observationForCodexReport(
      reportForCodexPayload({
        ...CODEX_HOOK_FIXTURES.PreToolUse,
        cwd: "/tmp/codex-home/.codex/memories",
      }),
    );
    const appServer = HarnessEventObservationSchema.parse(
      codexAppServerEventToHarnessEventObservation(
        {
          method: "item/tool/requestUserInput",
          id: 7,
          params: {
            threadId: "thr_input",
            turnId: "turn_1",
            itemId: "item_tool_1",
            questions: [],
          },
        },
        { observedAt: now },
      )[0],
    );

    expect(acceptsCodexPersistedEvent(valid)).toBe(true);
    expect(acceptsCodexPersistedEvent(mismatched)).toBe(false);
    expect(acceptsCodexPersistedEvent(appServer)).toBe(true);
    expect(acceptsCodexPersistedEvent({ ...mismatched, providerData: { legacy: true } })).toBe(
      true,
    );
    expect(
      acceptsCodexPersistedEvent({
        ...valid,
        eventType: "SubagentStop",
        rawEventType: "SubagentStop",
      }),
    ).toBe(false);
  });

  it("downgrades contradictory inherited identity to cwd hook scope", () => {
    const event = {
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_scope",
      provider: "codex",
      kind: "harness" as const,
      event: "PreToolUse",
      receivedAt: now,
      payload: CODEX_HOOK_FIXTURES.PreToolUse,
    };

    expect(codexHookAdapter.decideScope?.(event)).toEqual({
      action: "accept",
      reason: "station-env",
    });
    expect(
      codexHookAdapter.decideScope?.({
        ...event,
        payload: {
          ...CODEX_HOOK_FIXTURES.PreToolUse,
          cwd: "/tmp/codex-home/.codex/memories",
        },
      }),
    ).toEqual({ action: "accept", reason: "cwd" });
  });

  it("defers cwd-only worktree correlation to Observer projection", () => {
    const report = reportForCodexPayload({
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task/src/components",
      hook_event_name: "PostToolUse",
      model: "gpt-5.4-codex",
      permission_mode: "default",
      turn_id: "turn_1",
      tool_name: "Read",
      tool_input: { file_path: "Button.tsx" },
      tool_response: { ok: true },
      tool_use_id: "call_read",
    });

    expect(report.correlation).toEqual({
      cwd: "/tmp/station/web/task/src/components",
      nativeSessionId: "codex_session_123",
    });
    expect(report).toMatchObject({
      status: {
        value: "working",
      },
    });
  });

  it("leaves unmatched hook events uncorrelated", () => {
    const report = reportForCodexPayload({
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/other",
      hook_event_name: "PostToolUse",
      model: "gpt-5.4-codex",
      permission_mode: "default",
      turn_id: "turn_1",
      tool_name: "Read",
      tool_input: { file_path: "Button.tsx" },
      tool_response: { ok: true },
      tool_use_id: "call_read",
    });

    expect(report.correlation).toEqual({
      cwd: "/tmp/other",
      nativeSessionId: "codex_session_123",
    });
  });

  it("accepts current Codex lifecycle hook input shapes", () => {
    const common = {
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task",
      model: "gpt-5.5",
      permission_mode: "default",
    };
    const turn = {
      ...common,
      turn_id: "turn_1",
    };

    const payloads = [
      {
        ...common,
        hook_event_name: "SessionStart",
        source: "compact",
      },
      {
        ...turn,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test:all" },
        tool_use_id: "call_test",
      },
      {
        ...turn,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
        tool_response: "/tmp/station/web/task\n",
        tool_use_id: "call_test",
      },
      {
        ...turn,
        hook_event_name: "PreCompact",
        trigger: "manual",
        agent_id: "agent_1",
        agent_type: "reviewer",
      },
      {
        ...turn,
        hook_event_name: "PostCompact",
        trigger: "auto",
      },
      {
        ...turn,
        hook_event_name: "SubagentStart",
        agent_id: "agent_1",
        agent_type: "reviewer",
      },
    ];

    expect(payloads.map((payload) => parseCodexHookEvent(payload).hook_event_name)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SubagentStart",
    ]);
  });

  it("compacts status-safe Codex hook payloads without breaking strict parsing", () => {
    const common = {
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task",
      model: "gpt-5.5",
      permission_mode: "default",
      station_project_id: "web",
      station_worktree_id: "wt_web_task",
      station_worktree_path: "/tmp/station/web/task",
      station_session_id: "ses_web_task",
      station_terminal_provider: "tmux",
      station_terminal_target_id: "tmux:station:@1:%2",
    };
    const turn = {
      ...common,
      turn_id: "turn_1",
    };
    const rawSecret = "raw payload that should not survive compaction";
    const payloads = [
      {
        ...turn,
        hook_event_name: "UserPromptSubmit",
        prompt: `Please run ${rawSecret}`,
      },
      {
        ...turn,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `echo ${rawSecret}` },
        tool_use_id: "call_pre",
      },
      {
        ...turn,
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: `rm -rf ${rawSecret}` },
      },
      {
        ...turn,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
        tool_response: `stdout ${rawSecret}`,
        tool_use_id: "call_post",
      },
      {
        ...turn,
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: `Done with ${rawSecret}`,
      },
    ];

    const compactedPayloads = payloads.map((payload) => compactCodexHookPayload(payload));

    expect(
      compactedPayloads.map((result) => parseCodexHookEvent(result.payload).hook_event_name),
    ).toEqual(["UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"]);
    expect(JSON.stringify(compactedPayloads)).not.toContain(rawSecret);
    expect(compactedPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          compacted: true,
          omittedFieldNames: expect.arrayContaining(["tool_input"]),
        }),
        expect.objectContaining({
          compacted: true,
          omittedFieldNames: expect.arrayContaining(["tool_response"]),
        }),
        expect.objectContaining({
          compacted: true,
          omittedFieldNames: expect.arrayContaining(["prompt"]),
        }),
        expect.objectContaining({
          compacted: true,
          omittedFieldNames: expect.arrayContaining(["last_assistant_message"]),
        }),
      ]),
    );
    expect(compactedPayloads[1]?.payload).toMatchObject({
      hook_event_name: "PreToolUse",
      tool_input: {
        compacted: true,
        originalBytes: expect.any(Number),
      },
      station_project_id: "web",
      station_terminal_target_id: "tmux:station:@1:%2",
    });
    expect(compactedPayloads[0]?.payload).toMatchObject({
      prompt: expect.stringContaining("bytes"),
    });
    expect(compactedPayloads[4]?.payload).toMatchObject({
      last_assistant_message: null,
    });
  });

  it("maps compacted Codex hooks to provider-neutral reports without raw payloads", () => {
    const rawOutput = "raw stdout that must not leave the Codex boundary";
    const compacted = compactCodexHookPayload({
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task",
      hook_event_name: "PostToolUse",
      model: "gpt-5.4-codex",
      permission_mode: "default",
      turn_id: "turn_1",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: rawOutput,
      tool_use_id: "call_test",
      station_project_id: "web",
      station_worktree_id: "wt_web_task",
      station_session_id: "ses_web_task",
      station_terminal_target_id: "tmux:station:@1:%2",
    });

    const report = codexHookPayloadToHarnessEventReport({
      reportId: "report_codex_post_tool",
      observedAt: now,
      payload: compacted.payload,
      diagnostics: {
        payloadBytes: compacted.originalByteCount,
        compactedBytes: compacted.compactedByteCount,
        compacted: compacted.compacted,
        omittedFieldNames: compacted.omittedFieldNames,
      },
    });

    expect(report).toMatchObject({
      provider: "codex",
      kind: "harness",
      eventType: "PostToolUse",
      coalesceKey: "turn:turn_1:tool:call_test",
      status: {
        value: "working",
        source: "harness_event",
      },
      correlation: {
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        cwd: "/tmp/station/web/task",
      },
      diagnostics: {
        rawEventType: "PostToolUse",
        compacted: true,
        omittedFieldNames: expect.arrayContaining(["tool_input", "tool_response"]),
      },
      providerData: {
        codexSessionId: "codex_session_123",
        hookEventName: "PostToolUse",
        toolName: "Bash",
        toolUseId: "call_test",
      },
    });
    expect(JSON.stringify(report)).not.toContain(rawOutput);
    expect(JSON.stringify(report)).not.toContain("pnpm test");
    expect(codexHookPayloadReportId(compacted.payload, now)).toBe(
      "codex:codex_session_123:PostToolUse:turn_1:tool%3Acall_test",
    );
  });

  it("keeps Codex working and does not complete the turn when stop_hook_active is true", () => {
    const report = reportForCodexPayload({
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task",
      hook_event_name: "Stop",
      model: "gpt-5.4-codex",
      permission_mode: "default",
      turn_id: "turn_1",
      stop_hook_active: true,
      last_assistant_message: "Done.",
    });

    expect(report).toMatchObject({
      eventType: "Stop",
      status: {
        value: "working",
        confidence: "medium",
      },
    });
    expectStatusAllowedByCodexIngressRule("Stop", report.status);
    // A Stop hook forcing continuation must not mark the turn complete (no ready marker).
    expect(report.turn).toBeUndefined();
  });

  it("maps every supported Codex hook event to a provider-neutral report status", () => {
    const expected = [
      ["SessionStart", "starting", "high"],
      ["UserPromptSubmit", "working", "medium"],
      ["PreToolUse", "working", "medium"],
      ["PermissionRequest", "needs_attention", "high"],
      ["PostToolUse", "working", "medium"],
      ["PreCompact", "working", "medium"],
      ["PostCompact", "working", "medium"],
      ["SubagentStart", "working", "medium"],
      ["Stop", "idle", "high"],
    ] as const;

    const reports = codexReportPayloads().map((payload) =>
      codexHookPayloadToHarnessEventReport({
        reportId: `report_${payload.hook_event_name}`,
        observedAt: now,
        payload,
      }),
    );

    expect(
      reports.map((report) => [report.eventType, report.status?.value, report.status?.confidence]),
    ).toEqual(expected);
    expect(reports.map((report) => [report.eventType, report.turn?.kind ?? "none"])).toEqual([
      ["SessionStart", "none"],
      ["UserPromptSubmit", "none"],
      ["PreToolUse", "none"],
      ["PermissionRequest", "none"],
      ["PostToolUse", "none"],
      ["PreCompact", "none"],
      ["PostCompact", "none"],
      ["SubagentStart", "none"],
      ["Stop", "turn_completed"],
    ]);
    for (const report of reports) {
      expectStatusAllowedByCodexIngressRule(report.eventType, report.status);
      expect(report.provider).toBe("codex");
      expect(report.kind).toBe("harness");
      expect(report.status?.source).toBe("harness_event");
      expect(report.correlation?.nativeSessionId).toBe("codex_session_123");
      expect(report.diagnostics).toMatchObject({
        rawEventType: report.eventType,
      });
    }
  });

  it("throws typed provider errors for unsupported or mismatched payloads", () => {
    expect(() =>
      parseCodexHookEvent({
        session_id: "codex_session_123",
        transcript_path: null,
        cwd: "/tmp/station/web/task",
        hook_event_name: "SessionStart",
        model: "gpt-5.4-codex",
        source: "startup",
        unexpected: true,
      }),
    ).toThrowError(CodexHarnessProviderError);

    expect(() =>
      parseCodexHookEvent({
        session_id: "codex_session_123",
        transcript_path: null,
        cwd: "/tmp/station/web/task",
        hook_event_name: "UnknownFutureEvent",
        model: "gpt-5.4-codex",
      }),
    ).toThrowError(CodexHarnessProviderError);
  });
});

function reportForCodexPayload(payload: unknown): HarnessEventReport {
  return codexHookPayloadToHarnessEventReport({
    reportId: "report_test",
    observedAt: now,
    payload,
  });
}

function observationForCodexReport(report: HarnessEventReport) {
  return HarnessEventObservationSchema.parse({
    provider: report.provider,
    reportId: report.reportId,
    eventType: report.eventType,
    observedAt: report.observedAt,
    rawEventType: report.diagnostics?.rawEventType,
    diagnostics: report.diagnostics,
    providerData: report.providerData,
  });
}

type CodexHookFixtures = {
  [EventName in CodexHookEvent["hook_event_name"]]: Extract<
    CodexHookEvent,
    { hook_event_name: EventName }
  >;
};

const commonCodexHookFields = {
  session_id: "codex_session_123",
  transcript_path: null,
  cwd: "/tmp/station/web/task",
  model: "gpt-5.4-codex",
  permission_mode: "default",
  station_project_id: "web",
  station_worktree_id: "wt_web_task",
  station_worktree_path: "/tmp/station/web/task",
  station_session_id: "ses_web_task",
  station_terminal_target_id: "tmux:station:@1:%2",
} as const;

const turnCodexHookFields = {
  ...commonCodexHookFields,
  turn_id: "turn_1",
} as const;

const CODEX_HOOK_FIXTURES = {
  SessionStart: {
    ...commonCodexHookFields,
    hook_event_name: "SessionStart",
    source: "startup",
  },
  UserPromptSubmit: {
    ...turnCodexHookFields,
    hook_event_name: "UserPromptSubmit",
    prompt: "Implement the plan.",
  },
  PreToolUse: {
    ...turnCodexHookFields,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: {
      compacted: true,
      originalBytes: 128,
    },
    tool_use_id: "call_pre",
  },
  PermissionRequest: {
    ...turnCodexHookFields,
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: {
      compacted: true,
      originalBytes: 256,
    },
  },
  PostToolUse: {
    ...turnCodexHookFields,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: {
      compacted: true,
      originalBytes: 128,
    },
    tool_response: {
      compacted: true,
      originalBytes: 512,
    },
    tool_use_id: "call_post",
  },
  PreCompact: {
    ...turnCodexHookFields,
    hook_event_name: "PreCompact",
    trigger: "manual",
  },
  PostCompact: {
    ...turnCodexHookFields,
    hook_event_name: "PostCompact",
    trigger: "auto",
  },
  SubagentStart: {
    ...commonCodexHookFields,
    hook_event_name: "SubagentStart",
    turn_id: "turn_1",
    agent_id: "agent_1",
    agent_type: "reviewer",
  },
  Stop: {
    ...commonCodexHookFields,
    hook_event_name: "Stop",
    turn_id: "turn_1",
    stop_hook_active: false,
    last_assistant_message: null,
  },
} satisfies CodexHookFixtures;

function codexReportPayloads(): CodexHookEvent[] {
  return codexForwardedEventTypes.map((eventType) => CODEX_HOOK_FIXTURES[eventType]);
}

function expectStatusAllowedByCodexIngressRule(
  eventType: string,
  status: ObservedStatus | undefined,
): void {
  const rule = codexIngressRules.find((r) => r.eventType === eventType);
  expect(rule).toBeDefined();
  expect(rule?.statusIntents).toContain(status?.value);
  expect(rule?.confidences).toContain(status?.confidence);
}
