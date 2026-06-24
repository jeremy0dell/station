import { readFileSync } from "node:fs";
import type { HarnessEventContext } from "@station/contracts";
import { HarnessEventReportSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { compactClaudeHookPayload } from "../../src/compaction";
import {
  claudeHookPayloadReportId,
  claudeHookPayloadToHarnessEventReport,
  normalizeClaudeRawEvent,
  parseClaudeHookEvent,
  statusFromClaudeHookEvent,
} from "../../src/events";
import {
  claudeForwardedEventTypes,
  claudeIngressRuleForEventType,
  claudeIngressRules,
  isClaudeForwardedEventType,
} from "../../src/ingressRules";

const now = "2026-06-11T12:00:00.000Z";

const fixtureNames = [
  "session-start-startup",
  "session-start-resume",
  "session-start-clear",
  "user-prompt-submit",
  "pre-tool-use-bash",
  "post-tool-use-bash",
  "permission-request-bash",
  "notification-permission-prompt",
  "stop",
  "session-end-clear",
  "session-end-prompt-input-exit",
  "session-end-other",
] as const;

describe("claude ingress rules", () => {
  it("keeps forwarded event types unique and excludes turn-end subagent noise", () => {
    expect(new Set(claudeForwardedEventTypes).size).toBe(claudeForwardedEventTypes.length);
    expect(isClaudeForwardedEventType("SubagentStop")).toBe(false);
    expect(isClaudeForwardedEventType("SubagentStart")).toBe(false);
    expect(isClaudeForwardedEventType("PostToolUseFailure")).toBe(false);
  });

  it("maps every status-producing fixture onto its declared rule intents", () => {
    for (const name of fixtureNames) {
      const payload = fixture(name);
      const event = parseClaudeHookEvent(payload);
      const rule = claudeIngressRuleForEventType(event.hook_event_name);
      expect(rule, `rule for ${event.hook_event_name}`).toBeDefined();
      const status = statusFromClaudeHookEvent(event, now);
      if (status === undefined) {
        continue;
      }
      expect(rule?.statusIntents, `${name} intents`).toContain(status.value);
      expect(rule?.confidences, `${name} confidences`).toContain(status.confidence);
    }
  });

  it("declares status intents only for events the normalizer can produce", () => {
    for (const rule of claudeIngressRules) {
      expect(rule.provider).toBe("claude");
      expect(rule.statusIntents?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("statusFromClaudeHookEvent", () => {
  it("maps the turn lifecycle onto station states", () => {
    expect(statusFor("session-start-startup")).toMatchObject({
      value: "starting",
      confidence: "high",
    });
    expect(statusFor("user-prompt-submit")).toMatchObject({
      value: "working",
      confidence: "medium",
    });
    expect(statusFor("pre-tool-use-bash")).toMatchObject({
      value: "working",
      confidence: "medium",
    });
    expect(statusFor("post-tool-use-bash")).toMatchObject({
      value: "working",
      confidence: "medium",
    });
    expect(statusFor("stop")).toMatchObject({ value: "idle", confidence: "high" });
  });

  it("maps permission evidence to needs_attention", () => {
    expect(statusFor("permission-request-bash")).toMatchObject({
      value: "needs_attention",
      confidence: "high",
    });
    expect(statusFor("notification-permission-prompt")).toMatchObject({
      value: "needs_attention",
      confidence: "high",
    });
  });

  it("treats an idle-prompt notification as the interrupt recovery edge", () => {
    const event = parseClaudeHookEvent({
      ...fixture("notification-permission-prompt"),
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    });

    expect(statusFromClaudeHookEvent(event, now)).toMatchObject({
      value: "idle",
      confidence: "medium",
    });
  });

  it("produces no status for notification types it does not understand", () => {
    const event = parseClaudeHookEvent({
      ...fixture("notification-permission-prompt"),
      notification_type: "something_new",
    });

    expect(statusFromClaudeHookEvent(event, now)).toBeUndefined();
  });

  it("keeps a row working when a user Stop hook forces continuation", () => {
    const event = parseClaudeHookEvent({
      ...fixture("stop"),
      stop_hook_active: true,
    });

    expect(statusFromClaudeHookEvent(event, now)).toMatchObject({
      value: "working",
      confidence: "medium",
    });
    const report = claudeHookPayloadToHarnessEventReport({
      reportId: "report_active_stop",
      observedAt: now,
      payload: event,
    });
    expect(report.turn).toBeUndefined();
  });

  it("treats only terminal SessionEnd reasons as exited", () => {
    expect(statusFor("session-end-prompt-input-exit")).toMatchObject({
      value: "exited",
      confidence: "high",
    });
    expect(statusFor("session-end-other")).toMatchObject({
      value: "exited",
      confidence: "high",
    });
    expect(statusFor("session-end-clear")).toBeUndefined();
  });
});

describe("normalizeClaudeRawEvent", () => {
  it("drops unlisted-but-real claude events instead of erroring", () => {
    const observations = normalizeClaudeRawEvent(
      { provider: "claude", event: fixture("subagent-stop"), observedAt: now },
      emptyContext(),
    );

    expect(observations).toEqual([]);
  });

  it("prefers station identity fields over cwd correlation", () => {
    const payload = {
      ...fixture("stop"),
      station_session_id: "ses_env",
      station_worktree_id: "wt_env",
      station_terminal_target_id: "tmux:station:@1:%2",
    };
    const observations = normalizeClaudeRawEvent(
      { provider: "claude", event: payload, observedAt: now },
      contextWith({
        terminalCwd: "/somewhere/else",
        worktreePath: "/somewhere/else",
      }),
    );

    expect(observations[0]).toMatchObject({
      provider: "claude",
      rawEventType: "Stop",
      sessionId: "ses_env",
      worktreeId: "wt_env",
      harnessRunId: "claude:tmux:station:@1:%2",
      status: { value: "idle" },
    });
  });

  it("falls back to cwd correlation when identity fields are absent", () => {
    const observations = normalizeClaudeRawEvent(
      { provider: "claude", event: fixture("stop"), observedAt: now },
      contextWith({
        terminalCwd: "/work/project",
        worktreePath: "/work/project",
      }),
    );

    expect(observations[0]).toMatchObject({
      sessionId: "ses_ctx",
      worktreeId: "wt_ctx",
      harnessRunId: "claude:tmux:station:@1:%2",
    });
  });

  it("emits telemetry-only observations for SessionEnd(clear)", () => {
    const observations = normalizeClaudeRawEvent(
      { provider: "claude", event: fixture("session-end-clear"), observedAt: now },
      emptyContext(),
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]?.status).toBeUndefined();
    expect(observations[0]?.providerData).toMatchObject({ reason: "clear" });
  });
});

describe("compactClaudeHookPayload", () => {
  it("keeps every compacted fixture parseable while stripping sensitive content", () => {
    for (const name of fixtureNames) {
      const raw = fixture(name);
      const result = compactClaudeHookPayload(raw);
      const event = parseClaudeHookEvent(result.payload);
      expect(event.hook_event_name).toBe((raw as { hook_event_name: string }).hook_event_name);

      const serialized = JSON.stringify(result.payload);
      expect(serialized).not.toContain("echo hello-spike");
      expect(serialized).not.toContain("curl -s -o /dev/null");
      expect(serialized).not.toContain("Claude needs your permission");
    }
  });

  it("replaces prompt text with a byte-count placeholder", () => {
    const result = compactClaudeHookPayload(fixture("user-prompt-submit"));

    expect(result.compacted).toBe(true);
    expect(result.omittedFieldNames).toContain("prompt");
    expect((result.payload as { prompt: string }).prompt).toMatch(
      /^\[station compacted prompt: \d+ bytes\]$/,
    );
  });

  it("replaces tool payloads with compaction metadata", () => {
    const result = compactClaudeHookPayload(fixture("post-tool-use-bash"));
    const payload = result.payload as Record<string, unknown>;

    expect(payload.tool_input).toMatchObject({ compacted: true });
    expect(payload.tool_response).toMatchObject({ compacted: true });
    expect(result.omittedFieldNames).toEqual(
      expect.arrayContaining(["tool_input", "tool_response"]),
    );
  });

  it("drops Stop background task lists and nulls the assistant message", () => {
    const result = compactClaudeHookPayload(fixture("stop"));
    const payload = result.payload as Record<string, unknown>;

    expect(payload.last_assistant_message).toBeNull();
    expect(payload).not.toHaveProperty("background_tasks");
    expect(payload).not.toHaveProperty("session_crons");
    expect(result.omittedFieldNames).toEqual(
      expect.arrayContaining(["background_tasks", "session_crons", "last_assistant_message"]),
    );
  });

  it("reduces permission suggestions to compaction metadata", () => {
    const result = compactClaudeHookPayload(fixture("permission-request-bash"));
    const payload = result.payload as Record<string, unknown>;

    expect(payload.permission_suggestions).toMatchObject({ compacted: true });
    expect(JSON.stringify(payload)).not.toContain("ruleContent");
  });
});

describe("claudeHookPayloadToHarnessEventReport", () => {
  it("builds schema-valid provider-neutral reports from compacted payloads", () => {
    for (const name of fixtureNames) {
      const compacted = compactClaudeHookPayload({
        ...fixture(name),
        station_session_id: "ses_env",
        station_worktree_id: "wt_env",
        station_terminal_target_id: "tmux:station:@1:%2",
      });
      const report = claudeHookPayloadToHarnessEventReport({
        reportId: claudeHookPayloadReportId(compacted.payload, now),
        observedAt: now,
        payload: compacted.payload,
        diagnostics: {
          payloadBytes: compacted.originalByteCount,
          compactedBytes: compacted.compactedByteCount,
          compacted: compacted.compacted,
          omittedFieldNames: compacted.omittedFieldNames,
        },
      });

      expect(HarnessEventReportSchema.parse(report)).toEqual(report);
      expect(report).toMatchObject({
        provider: "claude",
        kind: "harness",
        correlation: {
          sessionId: "ses_env",
          worktreeId: "wt_env",
          terminalTargetId: "tmux:station:@1:%2",
          harnessRunId: "claude:tmux:station:@1:%2",
        },
      });
      if (report.eventType === "Stop") {
        expect(report.turn).toEqual({ kind: "turn_completed" });
      } else {
        expect(report.turn).toBeUndefined();
      }
      expect(JSON.stringify(report)).not.toContain("echo hello-spike");
    }
  });

  it("derives deterministic, turn-unique report ids", () => {
    const payload = compactClaudeHookPayload(fixture("stop")).payload;

    const first = claudeHookPayloadReportId(payload, now);
    const second = claudeHookPayloadReportId(payload, now);
    const laterTurn = claudeHookPayloadReportId(payload, "2026-06-11T12:05:00.000Z");

    expect(first).toBe(second);
    expect(first).not.toBe(laterTurn);
    expect(first).toContain("claude");
    expect(first).toContain("Stop");
  });

  it("coalesces tool bursts by tool_use_id", () => {
    const compacted = compactClaudeHookPayload(fixture("pre-tool-use-bash"));
    const report = claudeHookPayloadToHarnessEventReport({
      reportId: claudeHookPayloadReportId(compacted.payload, now),
      observedAt: now,
      payload: compacted.payload,
    });

    expect(report.coalesceKey).toMatch(/^tool:toolu_/);
  });

  it("rejects malformed payloads with a typed provider error", () => {
    expect(() =>
      claudeHookPayloadToHarnessEventReport({
        reportId: "claude:test",
        observedAt: now,
        payload: { hook_event_name: "Stop" },
      }),
    ).toThrowError(
      expect.objectContaining({
        tag: "HarnessProviderError",
        code: "HARNESS_CLAUDE_EVENT_INVALID",
        provider: "claude",
      }),
    );
  });
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
}

function statusFor(name: string) {
  return statusFromClaudeHookEvent(parseClaudeHookEvent(fixture(name)), now);
}

function emptyContext(): HarnessEventContext {
  return { projects: [], worktrees: [], terminalTargets: [] };
}

function contextWith(input: { terminalCwd: string; worktreePath: string }): HarnessEventContext {
  return {
    projects: [],
    worktrees: [
      {
        id: "wt_ctx",
        provider: "worktrunk",
        projectId: "web",
        branch: "task",
        path: input.worktreePath,
        state: "exists",
        source: "worktrunk",
        observedAt: now,
      },
    ],
    terminalTargets: [
      {
        id: "tmux:station:@1:%2",
        provider: "tmux",
        projectId: "web",
        worktreeId: "wt_ctx",
        sessionId: "ses_ctx",
        state: "open",
        cwd: input.terminalCwd,
        pid: 1234,
        confidence: "high",
        reason: "tmux pane has station identity binding.",
        observedAt: now,
      },
    ],
  };
}
