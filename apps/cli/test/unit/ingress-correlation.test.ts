import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogRecord } from "@station/contracts";
import { componentLogPath, createJsonlLogger, type JsonlLogger } from "@station/observability";
import { describe, expect, it } from "vitest";
import { fileExists, listHookSpoolFiles } from "../../../../tests/support/spool";
import { createTempState } from "../../../../tests/support/temp-projects";
import { runProviderIngressCommand, runProviderIngressMain } from "../../src/ingress/command.js";

const now = "2026-05-20T12:00:00.000Z";
const missingOwnershipMessage =
  "Provider hook ignored before Observer delivery because Station ownership was missing.";
const cwdOutsideRootsMessage =
  "Provider hook ignored before Observer delivery because cwd did not match a configured Station project/worktree root.";

type IngressDeps = NonNullable<Parameters<typeof runProviderIngressCommand>[2]>;

type IngressWorkCalls = {
  client: number;
  health: number;
  delivery: number;
  startup: number;
  spool: number;
  log: number;
};

describe("provider hook ingress correlation", () => {
  it.each([
    {
      provider: "codex",
      expectedEvent: "SubagentStop",
      providerArgs: ["codex"],
      payload: () => ({ ...codexPayload(), hook_event_name: "SubagentStop" }),
    },
    {
      provider: "claude",
      expectedEvent: "SubagentStop",
      providerArgs: ["claude"],
      payload: () => ({ ...claudePayload(), hook_event_name: "SubagentStop" }),
    },
    {
      provider: "opencode",
      expectedEvent: "message.part.delta",
      providerArgs: ["opencode", "message.part.delta"],
      payload: () => ({
        event_type: "message.part.delta",
        cwd: "/station-unsupported-outside-root",
        prompt: "unsupported-prompt-sentinel",
      }),
    },
  ])("keeps unsupported $provider events ahead of correlation and all ingress work", async ({
    provider,
    expectedEvent,
    providerArgs,
    payload,
  }) => {
    const fixture = await createTempState();
    const configPath = await writeConfigWithProject(fixture.root, fixture.root);
    const hookLogPath = componentLogPath(fixture.stateDir, "hook");
    const capture = capturingHookLogger(hookLogPath);
    const forbidden = ingressWorkForbiddenDeps(capture.logger, `hook_unsupported_${provider}`);

    const receipt = await runProviderIngressCommand(
      ["--config", configPath, "--no-auto-start", ...providerArgs],
      { stdin: JSON.stringify(payload()), env: {} },
      forbidden.deps,
    );

    expect(receipt).toMatchObject({
      accepted: false,
      status: "ignored",
      provider,
      event: expectedEvent,
    });
    expect(forbidden.calls).toEqual({
      client: 0,
      health: 0,
      delivery: 0,
      startup: 0,
      spool: 0,
      log: 0,
    });
    expect(capture.records).toEqual([]);
    await expect(fileExists(hookLogPath)).resolves.toBe(false);
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it.each([
    "claude",
    "codex",
  ] as const)("delivers env-less %s events with a cwd when no config supplies roots", async (provider) => {
    const fixture = await createTempState();
    const payload = provider === "claude" ? claudePayload() : codexPayload();

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--no-auto-start",
        provider,
      ],
      { stdin: JSON.stringify(payload), env: {} },
      {
        clock: { now: () => new Date(now) },
        hookId: () => `report_${provider}_unowned_with_cwd`,
      },
    );

    // External sessions must reach the observer (spooled here — none is
    // running) so cwd correlation can light their worktree row.
    expect(receipt).toMatchObject({
      status: "spooled",
      provider,
      event: "PreToolUse",
    });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toHaveLength(1);
  });

  it.each([
    "claude",
    "codex",
  ] as const)("delivers an env-less %s event whose cwd falls under a configured project root", async (provider) => {
    const fixture = await createTempState();
    // The project root must exist on disk; the payload cwd is compared as a
    // string, so a subdir of the root need not exist.
    const configPath = await writeConfigWithProject(fixture.root, fixture.root);
    const payload = provider === "claude" ? claudePayload() : codexPayload();

    const receipt = await runProviderIngressCommand(
      ["--config", configPath, "--no-auto-start", provider],
      {
        stdin: JSON.stringify({ ...payload, cwd: join(fixture.root, "web", "task") }),
        env: {},
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => `report_${provider}_in_root`,
      },
    );

    expect(receipt.status).toBe("spooled");
  });

  it.each([
    {
      provider: "claude",
      expectedEvent: "PreToolUse",
      hookId: "hook_claude_missing_ownership",
      providerArgs: ["claude"],
      payload: () => {
        const { cwd: _cwd, ...payload } = claudePayload();
        return payload;
      },
      reason: "missing-station-ownership" as const,
      message: missingOwnershipMessage,
    },
    {
      provider: "codex",
      expectedEvent: "PreToolUse",
      hookId: "hook_codex_missing_ownership",
      providerArgs: ["codex"],
      payload: () => {
        const { cwd: _cwd, ...payload } = codexPayload();
        return payload;
      },
      reason: "missing-station-ownership" as const,
      message: missingOwnershipMessage,
    },
    {
      provider: "claude",
      expectedEvent: "PreToolUse",
      hookId: "hook_claude_outside_roots",
      providerArgs: ["claude"],
      payload: () => ({ ...claudePayload(), cwd: "/station-outside-roots/claude" }),
      reason: "cwd-outside-configured-roots" as const,
      message: cwdOutsideRootsMessage,
    },
    {
      provider: "codex",
      expectedEvent: "PreToolUse",
      hookId: "hook_codex_outside_roots",
      providerArgs: ["codex"],
      payload: () => ({ ...codexPayload(), cwd: "/station-outside-roots/codex" }),
      reason: "cwd-outside-configured-roots" as const,
      message: cwdOutsideRootsMessage,
    },
    {
      provider: "cursor",
      expectedEvent: "beforeShellExecution",
      hookId: "hook_cursor_missing_ownership",
      providerArgs: ["cursor"],
      payload: cursorPayload,
      reason: "missing-station-ownership" as const,
      message: missingOwnershipMessage,
    },
    {
      provider: "pi",
      expectedEvent: "agent_end",
      hookId: "hook_pi_missing_ownership",
      providerArgs: ["pi", "agent_end"],
      payload: () => ({ event_type: "agent_end", command: "pi-command-sentinel" }),
      reason: "missing-station-ownership" as const,
      message: missingOwnershipMessage,
    },
    {
      provider: "opencode",
      expectedEvent: "session.idle",
      hookId: "hook_opencode_missing_ownership",
      providerArgs: ["opencode", "session.idle"],
      payload: () => ({ event_type: "session.idle", opencode_session_id: "native-session" }),
      reason: "missing-station-ownership" as const,
      message: missingOwnershipMessage,
    },
  ])("records one safe info log for an admitted $provider correlation failure", async ({
    provider,
    expectedEvent,
    hookId,
    providerArgs,
    payload,
    reason,
    message,
  }) => {
    const fixture = await createTempState();
    const configPath = await writeConfigWithProject(fixture.root, fixture.root);
    const hookLogPath = componentLogPath(fixture.stateDir, "hook");
    const capture = capturingHookLogger(hookLogPath);
    const forbidden = ingressWorkForbiddenDeps(capture.logger, hookId);

    const receipt = await runProviderIngressCommand(
      ["--config", configPath, "--no-auto-start", ...providerArgs],
      {
        stdin: JSON.stringify(payload()),
        env: { STATION_SESSION_ID: `incomplete-${provider}-session` },
      },
      forbidden.deps,
    );

    expect(receipt).toEqual({
      schemaVersion: "0.8.0",
      hookId,
      provider,
      event: expectedEvent,
      accepted: false,
      status: "ignored",
      receivedAt: now,
    });
    expect(forbidden.calls).toEqual({
      client: 0,
      health: 0,
      delivery: 0,
      startup: 0,
      spool: 0,
      log: 1,
    });
    expect(capture.records).toEqual([
      {
        timestamp: now,
        component: "hook",
        level: "info",
        message,
        provider,
        attributes: { hookId, status: "ignored", reason },
      },
    ]);
    const serialized = (await readFile(hookLogPath, "utf8")).trim().split("\n");
    expect(serialized).toHaveLength(1);
    expect(JSON.parse(serialized[0] ?? "null")).toEqual(capture.records[0]);
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("constructs ignored-correlation evidence without sensitive provider context", async () => {
    const fixture = await createTempState();
    const repositoryRoot = join(fixture.root, "repository-root-SENTINEL-47a8");
    await mkdir(repositoryRoot, { recursive: true });
    const configPath = await writeConfigWithProject(fixture.root, repositoryRoot);
    const hookLogPath = componentLogPath(fixture.stateDir, "hook");
    const capture = capturingHookLogger(hookLogPath);
    const forbidden = ingressWorkForbiddenDeps(capture.logger, "hook_redaction_safe");
    const sentinels = {
      cwd: "/outside/cwd-SENTINEL-184c",
      repositoryRoot,
      prompt: "prompt-SENTINEL-f031",
      command: "command-SENTINEL-7bb2",
      payload: "payload-SENTINEL-bd55",
      environment: "environment-SENTINEL-e219",
    };

    const receipt = await runProviderIngressCommand(
      ["--config", configPath, "--no-auto-start", "codex"],
      {
        stdin: JSON.stringify({
          ...codexPayload(),
          cwd: sentinels.cwd,
          prompt: sentinels.prompt,
          command: sentinels.command,
          raw_payload: sentinels.payload,
          tool_input: { command: sentinels.command },
        }),
        env: {
          STATION_SESSION_ID: sentinels.environment,
          PROVIDER_SECRET_SENTINEL: sentinels.environment,
        },
      },
      forbidden.deps,
    );

    expect(receipt.status).toBe("ignored");
    expect(capture.records).toEqual([
      {
        timestamp: now,
        component: "hook",
        level: "info",
        message: cwdOutsideRootsMessage,
        provider: "codex",
        attributes: {
          hookId: "hook_redaction_safe",
          status: "ignored",
          reason: "cwd-outside-configured-roots",
        },
      },
    ]);
    const capturedText = JSON.stringify(capture.records);
    const serializedText = await readFile(hookLogPath, "utf8");
    for (const sentinel of Object.values(sentinels)) {
      expect(capturedText).not.toContain(sentinel);
      expect(serializedText).not.toContain(sentinel);
    }
  });

  it("returns the same ignored receipt when correlation logging fails", async () => {
    const fixture = await createTempState();
    const hookLogPath = componentLogPath(fixture.stateDir, "hook");
    const writer = createJsonlLogger({
      component: "hook",
      path: hookLogPath,
      clock: { now: () => new Date(now) },
    });
    const failingLogger: JsonlLogger = {
      ...writer,
      log: async () => {
        throw new Error("hook log unavailable");
      },
    };
    const forbidden = ingressWorkForbiddenDeps(failingLogger, "hook_logging_failure");

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "cursor"],
      { stdin: JSON.stringify(cursorPayload()), env: {} },
      forbidden.deps,
    );

    expect(receipt).toEqual({
      schemaVersion: "0.8.0",
      hookId: "hook_logging_failure",
      provider: "cursor",
      event: "beforeShellExecution",
      accepted: false,
      status: "ignored",
      receivedAt: now,
    });
    expect(forbidden.calls).toEqual({
      client: 0,
      health: 0,
      delivery: 0,
      startup: 0,
      spool: 0,
      log: 1,
    });
    await expect(fileExists(hookLogPath)).resolves.toBe(false);
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("keeps ignored correlation failures silent at the CLI boundary", async () => {
    const fixture = await createTempState();

    const result = await runProviderIngressMain(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--no-auto-start",
        "cursor",
      ],
      { stdin: JSON.stringify(cursorPayload()), env: {} },
    );

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    const logLines = (await readFile(componentLogPath(fixture.stateDir, "hook"), "utf8"))
      .trim()
      .split("\n");
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0] ?? "null")).toMatchObject({
      level: "info",
      component: "hook",
      message: missingOwnershipMessage,
      provider: "cursor",
      attributes: {
        status: "ignored",
        reason: "missing-station-ownership",
      },
    });
  });
});

async function writeConfigWithProject(root: string, projectRoot: string): Promise<string> {
  const path = join(root, "config-project.toml");
  await writeFile(
    path,
    [
      "schema_version = 1",
      "",
      "[defaults]",
      'worktree_provider = "fake-worktree"',
      'terminal = "fake-terminal"',
      'harness = "fake-harness"',
      'layout = "agent-shell"',
      "",
      "[[projects]]",
      'id = "web"',
      'label = "web"',
      `root = ${JSON.stringify(projectRoot)}`,
      "",
      "[projects.defaults]",
      'harness = "fake-harness"',
      'terminal = "fake-terminal"',
      'layout = "agent-shell"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

function codexPayload() {
  return { hook_event_name: "PreToolUse", cwd: "/tmp/station/codex/task" };
}

function claudePayload() {
  return { hook_event_name: "PreToolUse", cwd: "/tmp/station/claude/task" };
}

function cursorPayload() {
  return { hook_event_name: "beforeShellExecution" };
}

function capturingHookLogger(path: string): { logger: JsonlLogger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const writer = createJsonlLogger({
    component: "hook",
    path,
    clock: { now: () => new Date(now) },
  });
  return {
    records,
    logger: {
      ...writer,
      log: async (record) => {
        const written = await writer.log(record);
        records.push(written);
        return written;
      },
    },
  };
}

function ingressWorkForbiddenDeps(
  logger: JsonlLogger,
  hookId: string,
): { deps: IngressDeps; calls: IngressWorkCalls } {
  const calls: IngressWorkCalls = {
    client: 0,
    health: 0,
    delivery: 0,
    startup: 0,
    spool: 0,
    log: 0,
  };
  const countedLogger: JsonlLogger = {
    ...logger,
    log: async (record) => {
      calls.log += 1;
      return logger.log(record);
    },
  };
  const deps: IngressDeps = {
    clock: { now: () => new Date(now) },
    hookId: () => hookId,
    clientFactory: () => {
      calls.client += 1;
      return {
        health: async () => {
          calls.health += 1;
          throw new Error("ignored hooks must not probe Observer health");
        },
        ingestProviderHookEvent: async () => {
          calls.delivery += 1;
          throw new Error("ignored hooks must not reach Observer delivery");
        },
      } as never;
    },
    spawnObserver: async () => {
      calls.startup += 1;
      throw new Error("ignored hooks must not start the Observer");
    },
    writeSpool: async () => {
      calls.spool += 1;
      throw new Error("ignored hooks must not be spooled");
    },
    logger: countedLogger,
  };
  return { deps, calls };
}
