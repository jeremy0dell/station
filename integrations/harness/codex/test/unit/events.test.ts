import type { RawHarnessEvent } from "@station/contracts";
import { HarnessEventObservationSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { compactCodexHookPayload } from "../../src/compaction";
import { CodexHarnessProviderError } from "../../src/errors";
import {
  codexHookPayloadReportId,
  codexHookPayloadToHarnessEventReport,
  normalizeCodexRawEvent,
  parseCodexHookEvent,
} from "../../src/events";

const now = "2026-05-21T12:00:00.000Z";

describe("Codex hook event parsing", () => {
  it("strictly parses documented SessionStart events and normalizes them", () => {
    const raw: RawHarnessEvent = {
      provider: "codex",
      observedAt: now,
      event: {
        session_id: "codex_session_123",
        transcript_path: null,
        cwd: "/tmp/station/web/task",
        hook_event_name: "SessionStart",
        model: "gpt-5.4-codex",
        permission_mode: "default",
        source: "startup",
      },
    };

    expect(parseCodexHookEvent(raw.event)).toMatchObject({
      hook_event_name: "SessionStart",
      source: "startup",
    });

    const observations = normalizeCodexRawEvent(raw, context());

    expect(observations).toHaveLength(1);
    expect(HarnessEventObservationSchema.parse(observations[0])).toEqual(observations[0]);
    expect(observations[0]).toMatchObject({
      provider: "codex",
      sessionId: "ses_web_task",
      worktreeId: "wt_web_task",
      rawEventType: "SessionStart",
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
    const observations = normalizeCodexRawEvent(
      {
        provider: "codex",
        observedAt: now,
        event: {
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
        },
      },
      context(),
    );

    expect(observations[0]).toMatchObject({
      rawEventType: "PermissionRequest",
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "Codex requested permission for Bash.",
        attention: "tool_approval",
      },
    });
    expect(JSON.stringify(observations[0]?.providerData)).not.toContain("rm -rf");
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

    const opened = normalizeCodexRawEvent(hookEvent("PreToolUse"), context());
    expect(opened[0]).toMatchObject({
      status: {
        value: "needs_attention",
        confidence: "high",
        reason: "Codex requested user input.",
        attention: "question",
      },
    });

    const resolved = normalizeCodexRawEvent(hookEvent("PostToolUse"), context());
    expect(resolved[0]).toMatchObject({
      status: {
        value: "working",
        confidence: "high",
        reason: "Codex received user input.",
      },
    });
    expect(resolved[0]?.status?.attention).toBeUndefined();
  });

  it("normalizes Codex app-server input requests through the harness ingest path", () => {
    const observations = normalizeCodexRawEvent(
      {
        provider: "codex",
        observedAt: now,
        event: {
          method: "item/tool/requestUserInput",
          id: 7,
          params: {
            threadId: "thr_input",
            turnId: "turn_1",
            itemId: "item_tool_1",
            questions: [],
          },
        },
      },
      context(),
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

  it("uses STATION hook context fields before cwd correlation", () => {
    const observations = normalizeCodexRawEvent(
      {
        provider: "codex",
        observedAt: now,
        event: {
          session_id: "codex_session_123",
          transcript_path: null,
          cwd: "/tmp/not-the-worktree",
          hook_event_name: "PreToolUse",
          model: "gpt-5.4-codex",
          permission_mode: "default",
          turn_id: "turn_1",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
          tool_use_id: "call_test",
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

    expect(observations[0]).toMatchObject({
      sessionId: "ses_web_task",
      worktreeId: "wt_web_task",
      harnessRunId: "codex:tmux:station:@1:%2",
      status: {
        value: "working",
      },
      providerData: {
        stationProjectId: "web",
        stationWorktreeId: "wt_web_task",
        stationSessionId: "ses_web_task",
        stationTerminalTargetId: "tmux:station:@1:%2",
      },
    });
  });

  it("correlates hook cwd values inside an observed worktree", () => {
    const observations = normalizeCodexRawEvent(
      {
        provider: "codex",
        observedAt: now,
        event: {
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
        },
      },
      context(),
    );

    expect(observations[0]).toMatchObject({
      sessionId: "ses_web_task",
      worktreeId: "wt_web_task",
      harnessRunId: "codex:tmux:station:@1:%2",
      status: {
        value: "working",
      },
    });
  });

  it("leaves unmatched hook events uncorrelated", () => {
    const observations = normalizeCodexRawEvent(
      {
        provider: "codex",
        observedAt: now,
        event: {
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
        },
      },
      context(),
    );

    expect(observations[0]?.sessionId).toBeUndefined();
    expect(observations[0]?.worktreeId).toBeUndefined();
    expect(observations[0]?.harnessRunId).toBeUndefined();
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
      {
        ...turn,
        hook_event_name: "SubagentStop",
        agent_transcript_path: null,
        agent_id: "agent_1",
        agent_type: "reviewer",
        stop_hook_active: false,
        last_assistant_message: "Reviewed.",
      },
    ];

    expect(payloads.map((payload) => parseCodexHookEvent(payload).hook_event_name)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SubagentStart",
      "SubagentStop",
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
      {
        ...turn,
        hook_event_name: "SubagentStop",
        agent_transcript_path: null,
        agent_id: "agent_1",
        agent_type: "reviewer",
        stop_hook_active: false,
        last_assistant_message: `Reviewed ${rawSecret}`,
      },
    ];

    const compactedPayloads = payloads.map((payload) => compactCodexHookPayload(payload));

    expect(
      compactedPayloads.map((result) => parseCodexHookEvent(result.payload).hook_event_name),
    ).toEqual([
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
      "SubagentStop",
    ]);
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
    const observations = normalizeCodexRawEvent(
      {
        provider: "codex",
        observedAt: now,
        event: {
          session_id: "codex_session_123",
          transcript_path: null,
          cwd: "/tmp/station/web/task",
          hook_event_name: "Stop",
          model: "gpt-5.4-codex",
          permission_mode: "default",
          turn_id: "turn_1",
          stop_hook_active: true,
          last_assistant_message: "Done.",
        },
      },
      context(),
    );

    expect(observations[0]).toMatchObject({
      rawEventType: "Stop",
      status: {
        value: "working",
        confidence: "medium",
      },
    });
    // A Stop hook forcing continuation must not mark the turn complete (no ready marker).
    expect(observations[0]?.turn).toBeUndefined();
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
      ["SubagentStop", "working", "medium"],
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
      ["SubagentStop", "none"],
      ["Stop", "turn_completed"],
    ]);
    for (const report of reports) {
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
          harnessProvider: "codex",
        },
      },
    ],
  };
}

function codexReportPayloads() {
  const common = {
    session_id: "codex_session_123",
    transcript_path: null,
    cwd: "/tmp/station/web/task",
    model: "gpt-5.4-codex",
    permission_mode: "default",
    station_project_id: "web",
    station_worktree_id: "wt_web_task",
    station_session_id: "ses_web_task",
    station_terminal_target_id: "tmux:station:@1:%2",
  };
  const turn = {
    ...common,
    turn_id: "turn_1",
  };

  return [
    {
      ...common,
      hook_event_name: "SessionStart",
      source: "startup",
    },
    {
      ...turn,
      hook_event_name: "UserPromptSubmit",
      prompt: "Implement the plan.",
    },
    {
      ...turn,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        compacted: true,
        originalBytes: 128,
      },
      tool_use_id: "call_pre",
    },
    {
      ...turn,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: {
        compacted: true,
        originalBytes: 256,
      },
    },
    {
      ...turn,
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
    {
      ...turn,
      hook_event_name: "PreCompact",
      trigger: "manual",
    },
    {
      ...turn,
      hook_event_name: "PostCompact",
      trigger: "auto",
    },
    {
      ...common,
      hook_event_name: "SubagentStart",
      turn_id: "turn_1",
      agent_id: "agent_1",
      agent_type: "reviewer",
    },
    {
      ...common,
      hook_event_name: "SubagentStop",
      turn_id: "turn_1",
      agent_transcript_path: null,
      agent_id: "agent_1",
      agent_type: "reviewer",
      stop_hook_active: false,
      last_assistant_message: null,
    },
    {
      ...common,
      hook_event_name: "Stop",
      turn_id: "turn_1",
      stop_hook_active: false,
      last_assistant_message: null,
    },
  ];
}
