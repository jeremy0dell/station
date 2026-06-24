import type { HarnessEventContext, RawHarnessEvent } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { normalizeCrushRawEvent } from "../../src/events";

const now = "2026-06-20T12:00:00.000Z";

describe("Crush hook event normalization", () => {
  it("maps PreToolUse hooks to diagnostic activity and STATION correlation", () => {
    const observations = normalizeCrushRawEvent(
      {
        provider: "crush",
        event: {
          event: "PreToolUse",
          session_id: "crush_session_1",
          cwd: "/tmp/station/web/task",
          tool_name: "bash",
          tool_input: { command: "pnpm test" },
          station_project_id: "web",
          station_worktree_id: "wt_web_task",
          station_worktree_path: "/tmp/station/web/task",
          station_session_id: "ses_web_task",
          station_terminal_provider: "tmux",
          station_terminal_target_id: "tmux:station:@1:%2",
        },
        observedAt: now,
      },
      eventContext(),
    );

    expect(observations).toEqual([
      expect.objectContaining({
        provider: "crush",
        rawEventType: "PreToolUse",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        terminalTargetId: "tmux:station:@1:%2",
        harnessRunId: "crush:tmux:station:@1:%2",
        nativeSessionId: "crush_session_1",
        cwd: "/tmp/station/web/task",
        providerData: {
          hookEventName: "PreToolUse",
          crushSessionId: "crush_session_1",
          cwd: "/tmp/station/web/task",
          toolName: "bash",
          stationProjectId: "web",
          stationWorktreeId: "wt_web_task",
          stationWorktreePath: "/tmp/station/web/task",
          stationSessionId: "ses_web_task",
          stationTerminalProvider: "tmux",
          stationTerminalTargetId: "tmux:station:@1:%2",
        },
      }),
    ]);
    expect(observations[0]).not.toHaveProperty("status");
    expect(JSON.stringify(observations)).not.toContain("pnpm test");
  });

  it("rejects unsupported Crush hook events", () => {
    const event: RawHarnessEvent = {
      provider: "crush",
      event: {
        event: "PostToolUse",
        session_id: "crush_session_1",
      },
      observedAt: now,
    };

    expect(() => normalizeCrushRawEvent(event, eventContext())).toThrow(
      "HARNESS_CRUSH_EVENT_INVALID",
    );
  });
});

function eventContext(): HarnessEventContext {
  return {
    projects: [],
    worktrees: [
      {
        id: "wt_web_task",
        provider: "worktrunk",
        projectId: "web",
        branch: "task",
        path: "/tmp/station/web/task",
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
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        state: "open",
        cwd: "/tmp/station/web/task",
        observedAt: now,
      },
    ],
  };
}
