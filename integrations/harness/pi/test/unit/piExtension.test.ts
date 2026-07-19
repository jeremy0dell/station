import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compactPiExtensionEvent,
  type PiExtensionDeps,
  registerStationPiExtension,
} from "../../src/piExtension";

type HookDelivery = Parameters<NonNullable<PiExtensionDeps["sendReport"]>>[0];

describe("station Pi extension", () => {
  it("keeps the extension runtime dependency-light", async () => {
    const source = await readFile(new URL("../../src/piExtension.ts", import.meta.url), "utf8");

    expect(source).toContain('from "./event/names.js"');
    expect(source).not.toContain('from "./events.js"');
    expect(source).toContain("node:child_process");
    expect(source).not.toContain("@station/protocol");
    expect(source).not.toContain("HarnessEventReportSpoolRecordSchema");
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
      "agent_settled",
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
          station_extension_protocol: 2,
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
            stationExtensionProtocol: 2,
            toolCallId: "toolu_1",
            toolName: "bash",
          },
        }),
      },
    ]);
    expect(JSON.stringify(delivered)).not.toContain("raw command body");
  });

  it("serializes prompt-open attention ahead of parallel sibling completion", async () => {
    const delivered: HookDelivery[] = [];
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
    const busHandlers = new Map<string, (data: unknown) => void>();
    let reportIndex = 0;

    registerStationPiExtension(
      {
        on: (event, handler) => handlers.set(event, handler),
        events: {
          on: (channel, handler) => {
            busHandlers.set(channel, handler);
            return undefined;
          },
        },
      },
      {
        env: env(),
        pid: 4321,
        reportId: () => `report_pi_question_${++reportIndex}`,
        sendReport: async (input) => {
          delivered.push(input);
        },
      },
    );

    await handlers.get("tool_execution_start")?.(
      { toolCallId: "question_1", toolName: "ask_user_question", args: { secret: true } },
      context(),
    );
    await handlers.get("tool_execution_start")?.(
      { toolCallId: "read_1", toolName: "read", args: { path: "/secret" } },
      context(),
    );
    busHandlers.get("rpiv:ask-user:prompt")?.({ question: "secret prompt" });
    await handlers.get("tool_execution_end")?.(
      { toolCallId: "read_1", toolName: "read", result: "secret result", isError: false },
      context(),
    );
    await handlers.get("tool_execution_end")?.(
      { toolCallId: "question_1", toolName: "ask_user_question", isError: false },
      context(),
    );

    expect(delivered.map((item) => item.eventType)).toEqual([
      "tool_execution_start",
      "tool_execution_start",
      "question_prompt_open",
      "tool_execution_end",
      "tool_execution_end",
    ]);
    expect(
      delivered.map((item) => [item.report.status?.value, item.report.status?.attention]),
    ).toEqual([
      ["working", undefined],
      ["working", undefined],
      ["needs_attention", "question"],
      ["needs_attention", "question"],
      ["working", undefined],
    ]);
    expect(delivered[3]?.payload).toMatchObject({
      tool_call_id: "read_1",
      active_question_call_id: "question_1",
    });
    expect(JSON.stringify(delivered)).not.toContain("secret");
  });

  it("does not open attention when question execution is rejected before its prompt", async () => {
    const delivered: HookDelivery[] = [];
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();

    registerStationPiExtension(
      {
        on: (event, handler) => handlers.set(event, handler),
        events: { on: () => undefined },
      },
      {
        env: env(),
        pid: 4321,
        reportId: () => `report_pi_rejected_${delivered.length}`,
        sendReport: async (input) => {
          delivered.push(input);
        },
      },
    );

    await handlers.get("tool_execution_start")?.(
      { toolCallId: "question_rejected", toolName: "ask_user_question" },
      context(),
    );
    await handlers.get("tool_execution_end")?.(
      { toolCallId: "question_rejected", toolName: "ask_user_question", isError: true },
      context(),
    );

    expect(delivered.map((item) => item.report.status?.value)).toEqual(["working", "working"]);
    expect(delivered.every((item) => item.report.status?.attention === undefined)).toBe(true);
  });

  it("retains settlement and compaction lifecycle metadata without summary bodies", () => {
    const rawSecret = "secret compaction summary";
    const settled = compactPiExtensionEvent("agent_settled", {}, context(), {
      env: env(),
      pid: 4321,
    });
    const compacted = compactPiExtensionEvent(
      "session_compact",
      {
        reason: "manual",
        willRetry: false,
        fromExtension: false,
        compactionEntry: {
          id: "compact_1",
          summary: rawSecret,
        },
      },
      context(),
      {
        env: env(),
        pid: 4321,
      },
    );

    expect(settled).toMatchObject({
      event_type: "agent_settled",
      cwd: "/tmp/station/web/task",
      station_extension_protocol: 2,
    });
    expect(compacted).toMatchObject({
      event_type: "session_compact",
      station_extension_protocol: 2,
      reason: "manual",
      will_retry: false,
      from_extension: false,
      compaction_entry_id: "compact_1",
    });
    expect(JSON.stringify(compacted)).not.toContain(rawSecret);
  });

  it("routes compact payloads and explicit runtime paths through stn-ingress", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-pi-extension-"));
    const ingressPath = join(root, "stn-ingress");
    const argsPath = join(root, "ingress-args.json");
    const stdinPath = join(root, "ingress-stdin.json");
    const spoolDir = join(root, "spool", "hooks");
    await writeFile(
      ingressPath,
      [
        `#!${process.execPath}`,
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        `process.stdin.on('end', () => writeFileSync(${JSON.stringify(stdinPath)}, input));`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
    const deps: PiExtensionDeps = {
      env: {
        ...env(),
        STATION_INGRESS_BIN: ingressPath,
        STATION_OBSERVER_SOCKET_PATH: join(root, "observer.sock"),
        STATION_OBSERVER_STATE_DIR: join(root, "state"),
        STATION_HOOK_SPOOL_DIR: spoolDir,
      },
      pid: 4321,
      reportId: () => {
        throw new Error("production ingress must not build a second normalized report");
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
    await handlers.get("session_start")?.({ reason: "startup" }, context());

    expect(await readJsonFile(argsPath)).toEqual([
      "--socket",
      join(root, "observer.sock"),
      "--state-dir",
      join(root, "state"),
      "--spool-dir",
      spoolDir,
      "--config",
      "/tmp/station/config.toml",
      "pi",
      "session_start",
    ]);
    expect(await readJsonFile(stdinPath)).toMatchObject({
      event_type: "session_start",
      reason: "startup",
      station_session_id: "ses_web_task",
      station_worktree_id: "wt_web_task",
      station_extension_protocol: 2,
    });
  });

  it("bounds a hung stn-ingress child without writing a provider-owned spool", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-pi-extension-"));
    const ingress = await writeHangingIngress(root);
    const spoolDir = join(root, "spool", "hooks");
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();

    registerStationPiExtension(
      {
        on: (event, handler) => {
          handlers.set(event, handler);
        },
      },
      {
        env: {
          ...env(),
          STATION_INGRESS_BIN: ingress.path,
          STATION_HOOK_SPOOL_DIR: spoolDir,
        },
      },
    );

    const startedAt = Date.now();
    await expect(
      handlers.get("session_start")?.({ reason: "startup" }, context()),
    ).resolves.toBeUndefined();

    expect(Date.now() - startedAt).toBeLessThan(7_000);
    await expect(access(ingress.startedPath)).resolves.toBeUndefined();
    await waitForProcessExit(Number(await readFile(ingress.pidPath, "utf8")));
    await expect(access(spoolDir)).rejects.toThrow();
  }, 8_000);

  it("omits prompts, answers, message bodies, tool results, and system prompts", () => {
    const rawSecret = "secret raw body";
    const payloads = [
      compactPiExtensionEvent(
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
      ),
      compactPiExtensionEvent(
        "tool_execution_start",
        {
          toolCallId: "question_1",
          toolName: "ask_user_question",
          args: { questions: [{ question: rawSecret }] },
        },
        context(),
        {
          env: env(),
          pid: 4321,
        },
      ),
      compactPiExtensionEvent(
        "tool_execution_end",
        {
          toolCallId: "question_1",
          toolName: "ask_user_question",
          result: {
            content: rawSecret,
            details: { answers: [rawSecret] },
          },
          isError: false,
        },
        context(),
        {
          env: env(),
          pid: 4321,
        },
      ),
    ];

    expect(payloads[0]).toMatchObject({
      event_type: "message_end",
      message_role: "assistant",
      cwd: "/tmp/station/web/task",
    });
    expect(payloads[1]).toMatchObject({
      event_type: "tool_execution_start",
      tool_call_id: "question_1",
      tool_name: "ask_user_question",
    });
    expect(payloads[2]).toMatchObject({
      event_type: "tool_execution_end",
      tool_call_id: "question_1",
      tool_name: "ask_user_question",
      is_error: false,
    });
    expect(JSON.stringify(payloads)).not.toContain(rawSecret);
  });
});

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse JSON file ${path}.`, { cause: error });
  }
}

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

async function writeHangingIngress(root: string) {
  const path = join(root, "stn-ingress");
  const startedPath = join(root, "ingress-started");
  const pidPath = join(root, "ingress-pid");
  await writeFile(
    path,
    [
      `#!${process.execPath}`,
      'const { writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      `  writeFileSync(${JSON.stringify(startedPath)}, 'started');`,
      "  setInterval(() => undefined, 1000);",
      "});",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { path, startedPath, pidPath };
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error(`Timed out waiting for ingress process ${pid} to exit.`);
}
