import { runCli } from "@station/cli";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";

type ExternalCommandCall = {
  command: string;
  args: string[];
  timeoutMs?: number | undefined;
};

describe("CLI notify command", () => {
  it("plays a sound and sends a clickable terminal-notifier notification for idle agent state events", async () => {
    const calls: ExternalCommandCall[] = [];
    const result = await runCli(["--config", "/tmp/station-test.toml", "notify", "agent-state"], {
      stdin: JSON.stringify(invocation("idle", { sessionId: "ses_web_task" })),
      notifyDeps: {
        cliCommandParts: ["station-test"],
        platform: "darwin",
        commandRunner: async (input) => {
          calls.push({
            command: input.command,
            args: input.args ?? [],
            timeoutMs: input.timeoutMs,
          });
          return {
            command: input.command,
            args: input.args ?? [],
            stdout: "",
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        notified: true,
        title: "Fix checkout notifications",
        notifier: "terminal-notifier",
        sound: "played",
        clickAction: true,
      },
    });
    expect(calls[0]).toEqual({
      command: "/usr/bin/afplay",
      args: ["/System/Library/Sounds/Glass.aiff"],
      timeoutMs: 5000,
    });
    expect(calls[1]).toMatchObject({
      command: "terminal-notifier",
      args: [
        "-title",
        "Fix checkout notifications",
        "-message",
        "Codex turn completed.",
        "-group",
        "station:ses_web_task",
        "-execute",
        expect.any(String),
        "-ignoreDnD",
      ],
    });
    const executeCommand = calls[1]?.args[7];
    expect(executeCommand).toContain(
      "'station-test' '--config' '/tmp/station-test.toml' 'command' 'dispatch'",
    );
    expect(executeCommand).toContain('"type":"terminal.focus"');
    expect(executeCommand).toContain('"sessionId":"ses_web_task"');
    expect(executeCommand).not.toContain('"targetId"');
  });

  it("falls back to osascript when terminal-notifier is not available", async () => {
    const calls: ExternalCommandCall[] = [];
    const result = await runCli(["notify", "agent-state"], {
      stdin: JSON.stringify(invocation("idle")),
      notifyDeps: {
        platform: "darwin",
        commandRunner: async (input) => {
          calls.push({
            command: input.command,
            args: input.args ?? [],
            timeoutMs: input.timeoutMs,
          });
          if (input.command === "terminal-notifier") {
            throw new Error("not installed");
          }
          return {
            command: input.command,
            args: input.args ?? [],
            stdout: "",
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        notified: true,
        title: "wt_web_task finished",
        notifier: "osascript",
        clickAction: false,
      },
    });
    expect(calls.map((call) => call.command)).toEqual([
      "/usr/bin/afplay",
      "terminal-notifier",
      "/usr/bin/osascript",
    ]);
    expect(calls[2]).toEqual({
      command: "/usr/bin/osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        "wt_web_task finished",
        "Codex turn completed.",
      ],
      timeoutMs: 3000,
    });
  });

  it("labels attention notifications and uses the attention sound", async () => {
    const calls: ExternalCommandCall[] = [];
    const result = await runCli(["notify", "agent-state"], {
      stdin: JSON.stringify(invocation("needs_attention")),
      notifyDeps: {
        cliCommandParts: ["station-test"],
        platform: "darwin",
        commandRunner: async (input) => {
          calls.push({
            command: input.command,
            args: input.args ?? [],
            timeoutMs: input.timeoutMs,
          });
          return {
            command: input.command,
            args: input.args ?? [],
            stdout: "",
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        notified: true,
        title: "wt_web_task needs attention",
      },
    });
    expect(calls[0]).toEqual({
      command: "/usr/bin/afplay",
      args: ["/System/Library/Sounds/Ping.aiff"],
      timeoutMs: 5000,
    });
    expect(calls[1]?.args).toContain("wt_web_task needs attention");
  });

  it("skips non-notifiable agent state events", async () => {
    const result = await runCli(["notify", "agent-state"], {
      stdin: JSON.stringify(invocation("working")),
      notifyDeps: { platform: "darwin" },
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        notified: false,
        skipped: true,
        reason: "agent-not-notifiable",
      },
    });
  });

  it("skips reconcile-driven idle state changes", async () => {
    const result = await runCli(["notify", "agent-state"], {
      stdin: JSON.stringify(invocation("idle", { changeSource: "reconcile" })),
      notifyDeps: { platform: "darwin" },
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        notified: false,
        skipped: true,
        reason: "non-hook-agent-state-change",
      },
    });
  });
});

function invocation(
  state: "idle" | "working" | "needs_attention",
  options: { sessionId?: string; changeSource?: "harness_event_report" | "reconcile" } = {},
) {
  const agent: Record<string, unknown> = {
    harness: "codex",
    state,
    confidence: "high",
    reason:
      state === "idle"
        ? "Codex turn completed."
        : state === "needs_attention"
          ? "Codex needs input."
          : "Codex is working.",
    updatedAt: "2026-06-01T12:00:00.000Z",
  };
  if (options.sessionId !== undefined) {
    agent.sessionId = options.sessionId;
  }
  const event: Record<string, unknown> = {
    type: "worktree.agentStateChanged",
    worktreeId: "wt_web_task",
    agent,
  };
  if (options.sessionId !== undefined) {
    event.sessionTitle = "Fix checkout notifications";
  }
  if (options.changeSource !== undefined) {
    event.changeSource = options.changeSource;
  }
  if (options.changeSource === "harness_event_report") {
    event.harnessEventType = state === "idle" ? "Stop" : "PermissionRequest";
  }
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: "notify-agent-state",
    observedAt: "2026-06-01T12:00:00.000Z",
    event,
  };
}
