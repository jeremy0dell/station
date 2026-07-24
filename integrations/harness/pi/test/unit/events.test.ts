import { readFileSync } from "node:fs";
import type { ProviderHookEvent, RawHarnessEvent } from "@station/contracts";
import { HarnessEventObservationSchema, STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { PiHarnessProviderError } from "../../src/errors";
import { compactFieldNamesForPiEvent } from "../../src/event/catalog";
import { PiCompactEventSchema, parsePiCompactEvent } from "../../src/event/compactEvent";
import { compactPiHookPayload } from "../../src/event/compaction";
import {
  normalizePiRawEvent,
  piHookPayloadToHarnessEventReport,
  statusFromPiEvent,
} from "../../src/event/mapping";
import { piSupportedEventNames } from "../../src/event/names";
import { piHookAdapter } from "../../src/hookAdapter";

const now = "2026-05-27T12:00:00.000Z";

describe("Pi compact event parsing", () => {
  it("strictly parses compact session_start events and normalizes them", () => {
    const raw: RawHarnessEvent = {
      provider: "pi",
      observedAt: now,
      event: {
        event_type: "session_start",
        cwd: "/tmp/station/web/task",
        pi_session_id: "pi_session_123",
        pi_session_file: "/tmp/pi/session.jsonl",
        model: {
          provider: "openai",
          id: "gpt-5.4",
        },
        reason: "startup",
        station_project_id: "web",
        station_worktree_id: "wt_web_task",
        station_worktree_path: "/tmp/station/web/task",
        station_session_id: "ses_web_task",
        station_terminal_provider: "tmux",
        station_terminal_target_id: "tmux:station:@1:%2",
      },
    };

    expect(parsePiCompactEvent(raw.event)).toMatchObject({
      event_type: "session_start",
      reason: "startup",
    });

    const observations = normalizePiRawEvent(raw, context());

    expect(observations).toHaveLength(1);
    expect(HarnessEventObservationSchema.parse(observations[0])).toEqual(observations[0]);
    expect(observations[0]).toMatchObject({
      provider: "pi",
      sessionId: "ses_web_task",
      worktreeId: "wt_web_task",
      harnessRunId: "pi:tmux:station:@1:%2",
      rawEventType: "session_start",
      status: {
        value: "starting",
        confidence: "high",
        source: "harness_event",
      },
      providerData: {
        piSessionId: "pi_session_123",
        piSessionFile: "/tmp/pi/session.jsonl",
        model: {
          id: "gpt-5.4",
        },
      },
    });
  });

  it("maps compact Pi events to provider-neutral reports without raw bodies", () => {
    const rawSecret = "raw content that must not leave the Pi boundary";
    const compacted = compactPiHookPayload("tool_execution_end", {
      event_type: "tool_execution_end",
      cwd: "/tmp/station/web/task",
      pi_session_id: "pi_session_123",
      tool_call_id: "toolu_1",
      tool_name: "bash",
      is_error: false,
      args: {
        command: `echo ${rawSecret}`,
      },
      result: rawSecret,
      station_project_id: "web",
      station_worktree_id: "wt_web_task",
      station_session_id: "ses_web_task",
      station_terminal_target_id: "tmux:station:@1:%2",
    });

    const report = piHookPayloadToHarnessEventReport({
      reportId: "report_pi_tool_end",
      eventType: "tool_execution_end",
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
      provider: "pi",
      kind: "harness",
      eventType: "tool_execution_end",
      coalesceKey: "tool:toolu_1",
      status: {
        value: "working",
        source: "harness_event",
      },
      correlation: {
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        harnessRunId: "pi:tmux:station:@1:%2",
        cwd: "/tmp/station/web/task",
      },
      diagnostics: {
        rawEventType: "tool_execution_end",
        compacted: true,
        omittedFieldNames: expect.arrayContaining(["args", "result"]),
      },
      providerData: {
        piSessionId: "pi_session_123",
        toolName: "bash",
        toolCallId: "toolu_1",
      },
    });
    expect(JSON.stringify(report)).not.toContain(rawSecret);
  });

  it.each([
    "ask-user-question-cancelled",
    "ask-user-question-answered",
  ])("replays %s with correlated question attention and resolution", (fixtureName) => {
    const [startedEvent, openedEvent, resolvedEvent] = eventSequenceFixture(fixtureName);
    if (
      startedEvent?.event_type !== "tool_execution_start" ||
      openedEvent?.event_type !== "question_prompt_open" ||
      resolvedEvent?.event_type !== "tool_execution_end"
    ) {
      throw new Error(`${fixtureName} did not contain a question start/open/end sequence.`);
    }

    const reports = [startedEvent, openedEvent, resolvedEvent].map((event, index) =>
      piHookPayloadToHarnessEventReport({
        reportId: `report_${fixtureName}_${index}`,
        eventType: event.event_type,
        observedAt: now,
        payload: event,
      }),
    );

    expect(reports[0]).toMatchObject({
      coalesceKey: `tool:${startedEvent.tool_call_id}`,
      status: { value: "working" },
    });
    expect(reports[1]).toMatchObject({
      coalesceKey: `tool:${startedEvent.tool_call_id}`,
      status: {
        value: "needs_attention",
        confidence: "high",
        attention: "question",
      },
      providerData: {
        toolCallId: startedEvent.tool_call_id,
        toolName: "ask_user_question",
      },
    });
    expect(reports[2]).toMatchObject({
      coalesceKey: `tool:${startedEvent.tool_call_id}`,
      status: {
        value: "working",
        confidence: "high",
      },
      providerData: {
        toolCallId: startedEvent.tool_call_id,
        toolName: "ask_user_question",
        isError: false,
      },
    });
    expect(reports[2]?.status?.attention).toBeUndefined();
    expect(resolvedEvent.tool_call_id).toBe(startedEvent.tool_call_id);
  });

  it("holds question attention across parallel sibling tool completion", () => {
    const reports = eventSequenceFixture("ask-user-question-parallel").map((event, index) =>
      piHookPayloadToHarnessEventReport({
        reportId: `report_pi_parallel_question_${index}`,
        eventType: event.event_type,
        observedAt: now,
        payload: event,
      }),
    );

    expect(reports.map((report) => [report.status?.value, report.status?.attention])).toEqual([
      ["working", undefined],
      ["working", undefined],
      ["needs_attention", "question"],
      ["needs_attention", "question"],
      ["working", undefined],
    ]);
    expect(reports[3]?.providerData).toMatchObject({
      toolName: "read",
      activeQuestionCallId: "question_parallel",
    });
  });

  it("does not open attention for a rejected question preflight", () => {
    const reports = eventSequenceFixture("ask-user-question-rejected").map((event, index) =>
      piHookPayloadToHarnessEventReport({
        reportId: `report_pi_rejected_question_${index}`,
        eventType: event.event_type,
        observedAt: now,
        payload: event,
      }),
    );

    expect(reports.map((report) => [report.status?.value, report.status?.attention])).toEqual([
      ["working", undefined],
      ["working", undefined],
    ]);
  });

  it("keeps low-level agent ends working until final settlement completes the turn", () => {
    const reports = eventSequenceFixture("agent-settlement").map((event, index) =>
      piHookPayloadToHarnessEventReport({
        reportId: `report_pi_settlement_${index}`,
        eventType: event.event_type,
        observedAt: now,
        payload: event,
      }),
    );

    for (const index of [1, 3, 5]) {
      expect(reports[index]).toMatchObject({
        eventType: "agent_end",
        status: {
          value: "working",
          confidence: "medium",
        },
      });
      expect(reports[index]?.turn).toBeUndefined();
    }
    expect(reports.at(-1)).toMatchObject({
      eventType: "agent_settled",
      status: {
        value: "idle",
        confidence: "high",
      },
      turn: {
        kind: "turn_completed",
      },
    });
  });

  it("preserves completion for an already-running legacy Station extension", () => {
    const report = piHookPayloadToHarnessEventReport({
      reportId: "report_pi_legacy_agent_end",
      eventType: "agent_end",
      observedAt: now,
      payload: {
        event_type: "agent_end",
        cwd: "/work/project",
        pi_session_id: "pi_session_legacy",
        station_project_id: "project",
        station_worktree_id: "wt_project",
        station_session_id: "ses_project",
      },
    });

    expect(report).toMatchObject({
      status: { value: "idle", confidence: "medium" },
      turn: { kind: "turn_completed" },
    });
    expect(report.providerData).not.toHaveProperty("stationExtensionProtocol");
  });

  it("replays manual, automatic, retried, and legacy compaction policy", () => {
    const reports = eventSequenceFixture("session-compaction").map((event, index) =>
      piHookPayloadToHarnessEventReport({
        reportId: `report_pi_compaction_${index}`,
        eventType: event.event_type,
        observedAt: now,
        payload: event,
      }),
    );

    expect(reports.map((report) => [report.status?.value, report.status?.confidence])).toEqual([
      ["idle", "high"],
      ["working", "medium"],
      ["working", "medium"],
      ["working", "medium"],
    ]);
    expect(reports[0]?.providerData).toMatchObject({
      compactionReason: "manual",
      willRetry: false,
    });
    expect(reports[1]?.providerData).toMatchObject({
      compactionReason: "threshold",
      willRetry: false,
    });
    expect(reports[2]?.providerData).toMatchObject({
      compactionReason: "overflow",
      willRetry: true,
    });
    expect(reports[3]?.providerData).not.toHaveProperty("compactionReason");
    expect(reports[3]?.providerData).not.toHaveProperty("willRetry");
  });

  it("maps every supported Pi event to the v1 status policy", () => {
    const expected = [
      ["session_start", "starting", "high"],
      ["session_shutdown", "exited", "high"],
      ["agent_start", "working", "high"],
      ["agent_end", "working", "medium"],
      ["agent_settled", "idle", "high"],
      ["turn_start", "working", "medium"],
      ["tool_execution_start", "working", "medium"],
      ["tool_execution_end", "working", "medium"],
      ["message_end", "working", "medium"],
      ["session_compact", "working", "medium"],
      ["question_prompt_open", "needs_attention", "high"],
    ] as const;

    const statuses = piPayloads().map((payload) => {
      const event = parsePiCompactEvent(payload);
      const status = statusFromPiEvent(event, now);
      return [event.event_type, status.value, status.confidence];
    });

    expect(statuses).toEqual(expected);
  });

  it("keeps the event descriptor catalog aligned with strict compact payloads", () => {
    const payloads = piPayloads();

    expect(payloads.map((payload) => payload.event_type)).toEqual(piSupportedEventNames);
    for (const payload of payloads) {
      const event = parsePiCompactEvent(payload);

      expect(compactFieldNamesForPiEvent(event.event_type)).toEqual(
        expect.arrayContaining(["event_type", "cwd"]),
      );
    }
  });

  it("keeps non-quit Pi shutdowns as working session transitions", () => {
    const event = parsePiCompactEvent({
      event_type: "session_shutdown",
      cwd: "/tmp/station/web/task",
      reason: "reload",
    });

    expect(statusFromPiEvent(event, now)).toMatchObject({
      value: "working",
      confidence: "medium",
      source: "harness_event",
      reason: "Pi session is shutting down for reload.",
    });
  });

  it("correlates compact events from cwd and terminal context when STATION ids are absent", () => {
    const observations = normalizePiRawEvent(
      {
        provider: "pi",
        observedAt: now,
        event: {
          event_type: "agent_start",
          cwd: "/tmp/station/web/task/src",
        },
      },
      context(),
    );

    expect(observations[0]).toMatchObject({
      sessionId: "ses_web_task",
      worktreeId: "wt_web_task",
      harnessRunId: "pi:tmux:station:@1:%2",
      status: {
        value: "working",
        confidence: "high",
      },
    });
  });

  it("rejects invalid compact payloads", () => {
    expect(() =>
      parsePiCompactEvent({
        event_type: "message_update",
        cwd: "/tmp/station/web/task",
      }),
    ).toThrowError(PiHarnessProviderError);

    expect(() =>
      parsePiCompactEvent({
        event_type: "session_start",
        cwd: "/tmp/station/web/task",
        prompt: "raw prompt body",
      }),
    ).toThrowError(PiHarnessProviderError);

    expect(() =>
      parsePiCompactEvent({
        event_type: "session_start",
        cwd: "/tmp/station/web/task",
        model: {
          provider: "openai",
          apiKey: "raw secret",
        },
      }),
    ).toThrowError(PiHarnessProviderError);

    expect(() =>
      parsePiCompactEvent({
        event_type: "agent_end",
        cwd: "/tmp/station/web/task",
        station_extension_protocol: 1,
      }),
    ).toThrowError(PiHarnessProviderError);

    expect(() =>
      parsePiCompactEvent({
        event_type: "question_prompt_open",
        cwd: "/tmp/station/web/task",
        tool_name: "ask_user_question",
      }),
    ).toThrowError(PiHarnessProviderError);
  });

  it("uses a schema-backed STATION identity envelope for Pi hook scope", () => {
    const baseEvent: ProviderHookEvent = {
      schemaVersion: STATION_SCHEMA_VERSION,
      provider: "pi",
      kind: "harness",
      event: "agent_start",
      receivedAt: now,
    };

    expect(
      piHookAdapter.enrichPayload?.({
        payload: {
          event_type: "agent_start",
          cwd: "/tmp/station/web/task",
        },
        env: {
          STATION_SESSION_ID: "ses_web_task",
          STATION_WORKTREE_ID: "wt_web_task",
        },
      }),
    ).toMatchObject({
      station_session_id: "ses_web_task",
      station_worktree_id: "wt_web_task",
    });
    expect(
      piHookAdapter.decideScope?.({
        ...baseEvent,
        payload: {
          station_session_id: "ses_web_task",
          station_worktree_id: "wt_web_task",
        },
      }),
    ).toEqual({ action: "accept", reason: "station-env" });
    expect(
      piHookAdapter.decideScope?.({
        ...baseEvent,
        payload: {
          station_session_id: "",
          station_worktree_id: "wt_web_task",
        },
      }),
    ).toEqual({ action: "ignore", reason: "missing-station-env" });
  });
});

function eventSequenceFixture(name: string) {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
  } catch (error) {
    throw new Error(`Could not parse Pi event fixture ${name}.`, { cause: error });
  }
  return PiCompactEventSchema.array().parse(value);
}

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
          harnessProvider: "pi",
        },
      },
    ],
  };
}

function piPayloads() {
  const common = {
    cwd: "/tmp/station/web/task",
    pi_session_id: "pi_session_123",
    station_project_id: "web",
    station_worktree_id: "wt_web_task",
    station_session_id: "ses_web_task",
    station_terminal_target_id: "tmux:station:@1:%2",
    station_extension_protocol: 2 as const,
  };

  return [
    {
      ...common,
      event_type: "session_start",
      reason: "startup",
    },
    {
      ...common,
      event_type: "session_shutdown",
      reason: "quit",
    },
    {
      ...common,
      event_type: "agent_start",
    },
    {
      ...common,
      event_type: "agent_end",
      message_count: 2,
    },
    {
      ...common,
      event_type: "agent_settled",
    },
    {
      ...common,
      event_type: "turn_start",
      turn_index: 1,
    },
    {
      ...common,
      event_type: "tool_execution_start",
      tool_call_id: "toolu_1",
      tool_name: "bash",
    },
    {
      ...common,
      event_type: "tool_execution_end",
      tool_call_id: "toolu_1",
      tool_name: "bash",
      is_error: false,
    },
    {
      ...common,
      event_type: "message_end",
      message_role: "assistant",
    },
    {
      ...common,
      event_type: "session_compact",
      from_extension: false,
    },
    {
      ...common,
      event_type: "question_prompt_open",
      tool_call_id: "question_1",
      tool_name: "ask_user_question",
    },
  ];
}
