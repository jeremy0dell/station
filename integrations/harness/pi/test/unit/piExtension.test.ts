import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compactPiExtensionEvent,
  type PiExtensionDeps,
  registerStationPiExtension,
} from "../../src/piExtension";

describe("station Pi extension", () => {
  it("keeps the extension runtime dependency-light", async () => {
    const source = await readFile(new URL("../../src/piExtension.ts", import.meta.url), "utf8");

    expect(source).toContain('from "./event/names.js"');
    expect(source).not.toContain('from "./events.js"');
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("station-hook");
  });

  it("registers only approved low-cardinality Pi events", () => {
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();

    registerStationPiExtension({
      on: (event, handler) => {
        handlers.set(event, handler);
      },
    });

    expect([...handlers.keys()]).toEqual([
      "session_start",
      "session_shutdown",
      "agent_start",
      "agent_end",
      "turn_start",
      "tool_execution_start",
      "tool_execution_end",
      "message_end",
      "session_compact",
    ]);
    expect(handlers.has("message_update")).toBe(false);
    expect(handlers.has("tool_execution_update")).toBe(false);
    expect(handlers.has("tool_call")).toBe(false);
    expect(handlers.has("input")).toBe(false);
    expect(handlers.has("user_bash")).toBe(false);
    expect(handlers.has("before_agent_start")).toBe(false);
  });

  it("emits compact harness reports through in-process delivery", async () => {
    const delivered: Array<{
      eventType: string;
      payload: Record<string, unknown>;
      report: { provider: string; eventType: string; providerData?: unknown };
    }> = [];
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
    const deps: PiExtensionDeps = {
      env: env(),
      pid: 4321,
      reportId: () => "report_pi_tool_start",
      sendReport: async (input) => {
        delivered.push(input);
      },
    };

    registerStationPiExtension(
      {
        on: (event, handler) => {
          handlers.set(event, handler);
        },
      },
      deps,
    );
    await handlers.get("tool_execution_start")?.(
      {
        toolCallId: "toolu_1",
        toolName: "bash",
        args: {
          command: "echo raw command body",
        },
      },
      context(),
    );

    expect(delivered).toEqual([
      {
        eventType: "tool_execution_start",
        payload: expect.objectContaining({
          event_type: "tool_execution_start",
          cwd: "/tmp/station/web/task",
          pid: 4321,
          tool_call_id: "toolu_1",
          tool_name: "bash",
          pi_session_id: "session",
          pi_session_file: "/tmp/pi/session.jsonl",
          station_project_id: "web",
          station_worktree_id: "wt_web_task",
          station_session_id: "ses_web_task",
          station_terminal_target_id: "tmux:station:@1:%2",
        }),
        report: expect.objectContaining({
          provider: "pi",
          eventType: "tool_execution_start",
          coalesceKey: "tool:toolu_1",
          providerData: {
            piSessionId: "session",
            piSessionFile: "/tmp/pi/session.jsonl",
            model: {
              provider: "openai",
              id: "gpt-5.4",
            },
            toolCallId: "toolu_1",
            toolName: "bash",
          },
        }),
      },
    ]);
    expect(JSON.stringify(delivered)).not.toContain("raw command body");
  });

  it("spools compact reports when the observer socket is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-pi-extension-"));
    const spoolDir = join(root, "spool", "hooks");
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
    const deps: PiExtensionDeps = {
      env: {
        ...env(),
        STATION_OBSERVER_SOCKET_PATH: join(root, "missing.sock"),
        STATION_HOOK_SPOOL_DIR: spoolDir,
      },
      pid: 4321,
      reportId: () => "report_pi_session_start",
    };

    registerStationPiExtension(
      {
        on: (event, handler) => {
          handlers.set(event, handler);
        },
      },
      deps,
    );
    await handlers.get("session_start")?.({ reason: "startup" }, context());

    const files = await readdir(spoolDir);
    expect(files).toHaveLength(1);
    const record = JSON.parse(await readFile(join(spoolDir, files[0] ?? ""), "utf8"));
    expect(record).toMatchObject({
      report: {
        reportId: "report_pi_session_start",
        provider: "pi",
        eventType: "session_start",
        correlation: {
          sessionId: "ses_web_task",
          worktreeId: "wt_web_task",
        },
      },
    });
  });

  it("omits prompts, message bodies, tool results, and system prompts", () => {
    const rawSecret = "secret raw body";
    const payload = compactPiExtensionEvent(
      "message_end",
      {
        prompt: rawSecret,
        systemPrompt: rawSecret,
        message: {
          role: "assistant",
          content: rawSecret,
        },
        result: rawSecret,
      },
      context(),
      {
        env: env(),
        pid: 4321,
      },
    );

    expect(payload).toMatchObject({
      event_type: "message_end",
      message_role: "assistant",
      cwd: "/tmp/station/web/task",
    });
    expect(JSON.stringify(payload)).not.toContain(rawSecret);
  });
});

function env(): Record<string, string> {
  return {
    STATION_PROJECT_ID: "web",
    STATION_WORKTREE_ID: "wt_web_task",
    STATION_WORKTREE_PATH: "/tmp/station/web/task",
    STATION_SESSION_ID: "ses_web_task",
    STATION_TERMINAL_PROVIDER: "tmux",
    STATION_TERMINAL_TARGET_ID: "tmux:station:@1:%2",
    STATION_CONFIG_PATH: "/tmp/station/config.toml",
  };
}

function context() {
  return {
    cwd: "/tmp/station/web/task",
    model: {
      provider: "openai",
      id: "gpt-5.4",
      apiKey: "not copied",
    },
    sessionManager: {
      getSessionFile: () => "/tmp/pi/session.jsonl",
    },
  };
}
