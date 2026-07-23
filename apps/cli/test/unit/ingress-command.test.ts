import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  LogRecord,
  ObserverHealth,
  ProviderHookEvent,
  ProviderHookReceipt,
} from "@station/contracts";
import { componentLogPath, createJsonlLogger, type JsonlLogger } from "@station/observability";
import { stationObserverBuildVersion } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { createRealStaleSocket } from "../../../../tests/support/sockets";
import {
  fileExists,
  listHookSpoolFiles,
  readHookSpoolRecord,
} from "../../../../tests/support/spool";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import { runProviderIngressCommand, runProviderIngressMain } from "../../src/ingress/command.js";

// A config with one project rooted at `projectRoot`, so the delivery gate for
// env-less sessions can be exercised (writeConfigToml hardcodes empty projects).
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

const now = "2026-05-20T12:00:00.000Z";
const missingOwnershipMessage =
  "Provider hook ignored before Observer delivery because Station ownership was missing.";
const cwdOutsideRootsMessage =
  "Provider hook ignored before Observer delivery because cwd did not match a configured Station project/worktree root.";

describe("provider hook ingress command", () => {
  it("turns raw observer flags into one finalized startup command", async () => {
    const fixture = await createTempState();
    const observerEntry = join(fixture.root, "custom-observer.js");
    await createRealStaleSocket(fixture.socketPath);
    let running = false;
    let staleSocketPresentAtSpawn = false;
    let spawnInput: Parameters<NonNullable<IngressDeps["spawnObserver"]>>[0] | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--observer-entry",
        observerEntry,
        "--startup-timeout-ms",
        "2000",
        "worktrunk",
        "post-create",
      ],
      { stdin: JSON.stringify({ branch: "feature/final-command" }) },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_final_command",
        clientFactory: () =>
          ({
            health: async () => {
              if (!running) throw new Error("offline");
              return healthyObserver(fixture);
            },
            ingestProviderHookEvent: async (event: ProviderHookEvent) => {
              if (!running) throw new Error("offline");
              return {
                schemaVersion: "0.8.0",
                hookId: event.hookId ?? "hook_final_command",
                provider: event.provider,
                event: event.event,
                accepted: true,
                status: "ingested",
                receivedAt: event.receivedAt,
                reconciled: false,
              } satisfies ProviderHookReceipt;
            },
          }) as never,
        spawnObserver: async (input) => {
          spawnInput = input;
          staleSocketPresentAtSpawn = await fileExists(fixture.socketPath);
          running = true;
          return { pid: 12345, unref: () => undefined };
        },
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(staleSocketPresentAtSpawn).toBe(true);
    expect(spawnInput).toEqual({
      paths: expect.objectContaining({
        socketPath: fixture.socketPath,
        stateDir: fixture.stateDir,
      }),
      observerCommand: [process.execPath, observerEntry],
    });
  });

  it("passes the remaining startup budget to the production observer child", async () => {
    const fixture = await createTempState();
    const observerEntry = join(fixture.root, "record-observer-argv.cjs");
    const argvPath = join(fixture.root, "observer-argv.json");
    await writeFile(
      observerEntry,
      [
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
      ].join("\n"),
      "utf8",
    );

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--observer-entry",
        observerEntry,
        "--startup-timeout-ms",
        "2000",
        "worktrunk",
        "post-create",
      ],
      { stdin: JSON.stringify({ branch: "feature/child-timeout" }) },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_child_timeout",
        clientFactory: () =>
          ({
            health: async () => {
              if (!(await fileExists(argvPath))) throw new Error("offline");
              return healthyObserver(fixture);
            },
            ingestProviderHookEvent: async (event: ProviderHookEvent) => {
              if (!(await fileExists(argvPath))) throw new Error("offline");
              return {
                schemaVersion: "0.8.0",
                hookId: event.hookId ?? "hook_child_timeout",
                provider: event.provider,
                event: event.event,
                accepted: true,
                status: "ingested",
                receivedAt: event.receivedAt,
                reconciled: false,
              } satisfies ProviderHookReceipt;
            },
          }) as never,
      },
    );

    expect(receipt.status).toBe("ingested");
    const childArgv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    expect(childArgv.slice(0, -1)).toEqual([
      "--socket",
      fixture.socketPath,
      "--state-dir",
      fixture.stateDir,
      "--startup-timeout-ms",
    ]);
    const childTimeoutMs = Number(childArgv.at(-1));
    expect(childTimeoutMs).toBeGreaterThan(0);
    expect(childTimeoutMs).toBeLessThanOrEqual(2000);
  });

  it("delivers Worktrunk lifecycle hooks through observer.ingestProviderHookEvent", async () => {
    const fixture = await createTempState();
    let observedPayload: unknown;
    let observedSocketPath = "";

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "worktrunk", "post-create"],
      {
        stdin: JSON.stringify({ branch: "feature/run-cli" }),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_worktrunk_1",
        clientFactory: (socketPath) => {
          observedSocketPath = socketPath;
          const ingest = async (event: ProviderHookEvent): Promise<ProviderHookReceipt> => {
            observedPayload = event.payload;
            return {
              schemaVersion: "0.8.0",
              hookId: event.hookId ?? "hook_worktrunk_1",
              provider: event.provider,
              event: event.event,
              accepted: true,
              status: "ingested",
              receivedAt: event.receivedAt,
              reconciled: false,
            };
          };
          return {
            health: async () => healthyObserver(fixture),
            ingestProviderHookEvent: ingest,
          } as never;
        },
      },
    );

    expect(receipt).toMatchObject({
      status: "ingested",
      provider: "worktrunk",
      event: "post-create",
    });
    expect(observedSocketPath).toBe(fixture.socketPath);
    expect(observedPayload).toEqual({ branch: "feature/run-cli" });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("resolves observer delivery and spool paths from --config without explicit path flags", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedSocketPath = "";
    let observedSpoolDir = "";

    const receipt = await runProviderIngressCommand(
      ["--config", configPath, "--no-auto-start", "worktrunk", "post-create"],
      {
        stdin: JSON.stringify({ branch: "feature/config-only" }),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_worktrunk_config_only",
        clientFactory: (socketPath) => {
          observedSocketPath = socketPath;
          const ingest = async (): Promise<ProviderHookReceipt> => {
            throw new Error("offline");
          };
          return {
            health: async () => healthyObserver(fixture),
            ingestProviderHookEvent: ingest,
          } as never;
        },
        writeSpool: async ({ spoolDir, event, error, clock }) => {
          observedSpoolDir = spoolDir;
          return {
            schemaVersion: "0.8.0",
            hookId: event.hookId ?? "hook_worktrunk_config_only",
            provider: event.provider,
            event: event.event,
            accepted: true,
            status: "spooled",
            receivedAt: event.receivedAt,
            spooledAt: clock === undefined ? now : clock.now().toISOString(),
            ...(error === undefined ? {} : { error }),
          };
        },
      },
    );

    expect(receipt).toMatchObject({
      status: "spooled",
      provider: "worktrunk",
      event: "post-create",
    });
    expect(observedSocketPath).toBe(fixture.socketPath);
    expect(observedSpoolDir).toBe(fixture.hookSpoolDir);
  });

  it("rejects removed Crush hook sender targets", async () => {
    const fixture = await createTempState();

    await expect(
      runProviderIngressCommand(
        ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "crush"],
        {
          stdin: JSON.stringify({ event: "PreToolUse" }),
          env: stationEnv(),
        },
      ),
    ).rejects.toThrow("Unsupported provider hook sender: crush");
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("delivers raw Codex hook payloads through observer.ingestProviderHookEvent", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedEvent: ProviderHookEvent | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--config",
        configPath,
        "codex",
      ],
      {
        stdin: JSON.stringify(codexPayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_codex_1",
        clientFactory: () => {
          const ingest = async (event: ProviderHookEvent): Promise<ProviderHookReceipt> => {
            observedEvent = event;
            return {
              schemaVersion: "0.8.0",
              hookId: event.hookId ?? "hook_1",
              provider: event.provider,
              event: event.event,
              accepted: true,
              status: "ingested",
              receivedAt: event.receivedAt,
              reconciled: false,
            };
          };
          return {
            health: async () => healthyObserver(fixture),
            ingestProviderHookEvent: ingest,
            ingestHookEvent: ingest,
          } as never;
        },
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(observedEvent).toMatchObject({
      provider: "codex",
      kind: "harness",
      event: "PreToolUse",
      hookId: "hook_codex_1",
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "codex_session_1",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        station_project_id: "web",
        station_worktree_id: "wt_web_task",
        station_session_id: "ses_web_task",
      },
    });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("ignores delayed Codex SubagentStop before observer, startup, spool, or logging work", async () => {
    const fixture = await createTempState();
    let clientCalls = 0;
    let healthCalls = 0;
    let deliveryCalls = 0;
    let startupCalls = 0;
    let spoolCalls = 0;
    let logCalls = 0;

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "codex"],
      {
        stdin: JSON.stringify({
          ...codexPayload(),
          hook_event_name: "SubagentStop",
        }),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_codex_subagent_stop",
        clientFactory: () => {
          clientCalls += 1;
          return {
            health: async () => {
              healthCalls += 1;
              return healthyObserver(fixture);
            },
            ingestProviderHookEvent: async () => {
              deliveryCalls += 1;
              throw new Error("ignored Codex hooks must not be delivered");
            },
          } as never;
        },
        spawnObserver: async () => {
          startupCalls += 1;
          throw new Error("ignored Codex hooks must not start the observer");
        },
        writeSpool: async () => {
          spoolCalls += 1;
          throw new Error("ignored Codex hooks must not be spooled");
        },
        logger: {
          log: async () => {
            logCalls += 1;
            throw new Error("ignored Codex hooks must not be logged");
          },
        } as never,
      },
    );

    expect(receipt).toMatchObject({
      accepted: false,
      status: "ignored",
      provider: "codex",
      event: "SubagentStop",
    });
    expect({
      clientCalls,
      healthCalls,
      deliveryCalls,
      startupCalls,
      spoolCalls,
      logCalls,
    }).toEqual({
      clientCalls: 0,
      healthCalls: 0,
      deliveryCalls: 0,
      startupCalls: 0,
      spoolCalls: 0,
      logCalls: 0,
    });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

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
    const forbidden = observerWorkForbiddenDeps(capture.logger, `hook_unsupported_${provider}`);

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

  it("delivers raw Claude hook payloads through observer.ingestProviderHookEvent", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedEvent: ProviderHookEvent | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--config",
        configPath,
        "claude",
      ],
      {
        stdin: JSON.stringify(claudePayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_claude_1",
        clientFactory: () => {
          const ingest = async (event: ProviderHookEvent): Promise<ProviderHookReceipt> => {
            observedEvent = event;
            return {
              schemaVersion: "0.8.0",
              hookId: event.hookId ?? "hook_1",
              provider: event.provider,
              event: event.event,
              accepted: true,
              status: "ingested",
              receivedAt: event.receivedAt,
              reconciled: false,
            };
          };
          return {
            health: async () => healthyObserver(fixture),
            ingestProviderHookEvent: ingest,
            ingestHookEvent: ingest,
          } as never;
        },
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(observedEvent).toMatchObject({
      provider: "claude",
      kind: "harness",
      event: "PreToolUse",
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "claude_session_1",
        station_worktree_id: "wt_web_task",
        station_session_id: "ses_web_task",
      },
    });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("ignores Claude events outside the rule-derived allow-list", async () => {
    const fixture = await createTempState();

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "claude"],
      {
        stdin: JSON.stringify({
          ...claudePayload(),
          hook_event_name: "SubagentStop",
        }),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_claude_drop_1",
      },
    );

    expect(receipt).toMatchObject({
      status: "ignored",
      provider: "claude",
      event: "SubagentStop",
    });
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

  it("ignores Claude events with neither station ownership env nor a payload cwd", async () => {
    const fixture = await createTempState();
    const { cwd: _cwd, ...payloadWithoutCwd } = claudePayload();

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "claude"],
      {
        stdin: JSON.stringify(payloadWithoutCwd),
        env: {},
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_claude_unowned_2",
      },
    );

    expect(receipt).toMatchObject({
      status: "ignored",
      provider: "claude",
      event: "PreToolUse",
    });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
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

  it("ignores an env-less Claude event whose cwd is under no configured project root", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigWithProject(fixture.root, fixture.root);

    const receipt = await runProviderIngressCommand(
      ["--config", configPath, "--no-auto-start", "claude"],
      {
        stdin: JSON.stringify({ ...claudePayload(), cwd: "/tmp/unrelated/elsewhere" }),
        env: {},
      },
      { clock: { now: () => new Date(now) }, hookId: () => "report_claude_out_of_root" },
    );

    expect(receipt).toMatchObject({ status: "ignored", provider: "claude" });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it.each([
    {
      provider: "claude",
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
      hookId: "hook_claude_outside_roots",
      providerArgs: ["claude"],
      payload: () => ({ ...claudePayload(), cwd: "/station-outside-roots/claude" }),
      reason: "cwd-outside-configured-roots" as const,
      message: cwdOutsideRootsMessage,
    },
    {
      provider: "codex",
      hookId: "hook_codex_outside_roots",
      providerArgs: ["codex"],
      payload: () => ({ ...codexPayload(), cwd: "/station-outside-roots/codex" }),
      reason: "cwd-outside-configured-roots" as const,
      message: cwdOutsideRootsMessage,
    },
    {
      provider: "cursor",
      hookId: "hook_cursor_missing_ownership",
      providerArgs: ["cursor"],
      payload: cursorPayload,
      reason: "missing-station-ownership" as const,
      message: missingOwnershipMessage,
    },
    {
      provider: "pi",
      hookId: "hook_pi_missing_ownership",
      providerArgs: ["pi", "agent_end"],
      payload: () => ({ event_type: "agent_end", command: "pi-command-sentinel" }),
      reason: "missing-station-ownership" as const,
      message: missingOwnershipMessage,
    },
    {
      provider: "opencode",
      hookId: "hook_opencode_missing_ownership",
      providerArgs: ["opencode", "session.idle"],
      payload: () => ({ event_type: "session.idle", opencode_session_id: "native-session" }),
      reason: "missing-station-ownership" as const,
      message: missingOwnershipMessage,
    },
  ])("records one safe info log for an admitted $provider correlation failure", async ({
    provider,
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
    const forbidden = observerWorkForbiddenDeps(capture.logger, hookId);

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
      event:
        provider === "cursor"
          ? "beforeShellExecution"
          : provider === "pi"
            ? "agent_end"
            : provider === "opencode"
              ? "session.idle"
              : "PreToolUse",
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
    const forbidden = observerWorkForbiddenDeps(capture.logger, "hook_redaction_safe");
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
    const forbidden = observerWorkForbiddenDeps(failingLogger, "hook_logging_failure");

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

  it("delivers raw Cursor hook payloads through observer.ingestProviderHookEvent", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedEvent: ProviderHookEvent | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--config",
        configPath,
        "cursor",
      ],
      {
        stdin: JSON.stringify(cursorPayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_cursor_1",
        clientFactory: () => {
          const ingest = async (event: ProviderHookEvent): Promise<ProviderHookReceipt> => {
            observedEvent = event;
            return {
              schemaVersion: "0.8.0",
              hookId: event.hookId ?? "hook_1",
              provider: event.provider,
              event: event.event,
              accepted: true,
              status: "ingested",
              receivedAt: event.receivedAt,
              reconciled: false,
            };
          };
          return {
            health: async () => healthyObserver(fixture),
            ingestProviderHookEvent: ingest,
            ingestHookEvent: ingest,
          } as never;
        },
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(observedEvent).toMatchObject({
      provider: "cursor",
      kind: "harness",
      event: "beforeShellExecution",
      payload: {
        hook_event_name: "beforeShellExecution",
        session_id: "cursor_session_1",
        station_worktree_id: "wt_web_task",
      },
    });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("delivers compact OpenCode payloads through build-aware provider ingress", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const buildVersion = `0.8.0+station.${"a".repeat(64)}`;
    let observedEvent: ProviderHookEvent | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--config",
        configPath,
        "opencode",
        "session.idle",
      ],
      {
        stdin: JSON.stringify({
          event_type: "session.idle",
          observed_at: now,
          opencode_session_id: "opencode_session_1",
        }),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_opencode_1",
        buildVersion,
        clientFactory: () => {
          const ingest = async (event: ProviderHookEvent): Promise<ProviderHookReceipt> => {
            observedEvent = event;
            return {
              schemaVersion: "0.8.0",
              hookId: event.hookId ?? "hook_opencode_1",
              provider: event.provider,
              event: event.event,
              accepted: true,
              status: "ingested",
              receivedAt: event.receivedAt,
              reconciled: false,
            };
          };
          return {
            health: async () => ({
              schemaVersion: "0.8.0",
              status: "healthy",
              pid: 12345,
              startedAt: now,
              version: buildVersion,
              socketPath: fixture.socketPath,
              stateDir: fixture.stateDir,
            }),
            ingestProviderHookEvent: ingest,
            ingestHookEvent: ingest,
          } as never;
        },
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(observedEvent).toMatchObject({
      hookId: "hook_opencode_1",
      provider: "opencode",
      kind: "harness",
      event: "session.idle",
      payload: {
        event_type: "session.idle",
        observed_at: now,
        opencode_session_id: "opencode_session_1",
        station_project_id: "web",
        station_worktree_id: "wt_web_task",
        station_session_id: "ses_web_task",
      },
    });
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("returns online provider payload rejections without retrying, starting, or spooling", async () => {
    const fixture = await createTempState();
    const buildVersion = `0.8.0+station.${"b".repeat(64)}`;
    let healthCalls = 0;
    let deliveryCalls = 0;
    let startCalls = 0;
    let spoolCalls = 0;

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "pi", "agent_end"],
      {
        stdin: JSON.stringify({ event_type: "agent_end" }),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_pi_invalid",
        buildVersion,
        clientFactory: () =>
          ({
            health: async () => {
              healthCalls += 1;
              return {
                schemaVersion: "0.8.0",
                status: "healthy",
                pid: 12345,
                startedAt: now,
                version: buildVersion,
                socketPath: fixture.socketPath,
                stateDir: fixture.stateDir,
              } satisfies ObserverHealth;
            },
            ingestProviderHookEvent: async (
              event: ProviderHookEvent,
            ): Promise<ProviderHookReceipt> => {
              deliveryCalls += 1;
              return {
                schemaVersion: "0.8.0",
                hookId: event.hookId ?? "hook_pi_invalid",
                provider: event.provider,
                event: event.event,
                accepted: false,
                status: "rejected",
                receivedAt: event.receivedAt,
                error: {
                  tag: "HookPayloadError",
                  code: "HOOK_REPORT_INVALID",
                  message: "Provider hook payload could not be normalized.",
                  provider: event.provider,
                },
              };
            },
          }) as never,
        spawnObserver: async () => {
          startCalls += 1;
          throw new Error("online payload rejection must not start an observer");
        },
        writeSpool: async () => {
          spoolCalls += 1;
          throw new Error("online payload rejection must not be spooled");
        },
      },
    );

    expect(receipt).toMatchObject({
      status: "rejected",
      error: { code: "HOOK_REPORT_INVALID" },
    });
    expect(healthCalls).toBe(1);
    expect(deliveryCalls).toBe(1);
    expect(startCalls).toBe(0);
    expect(spoolCalls).toBe(0);
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });

  it("passes the delivery timeout to the observer protocol client", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let observedTimeoutMs: number | undefined;
    let observedBuildVersion: string | undefined;

    const receipt = await runProviderIngressCommand(
      [
        "--socket",
        fixture.socketPath,
        "--state-dir",
        fixture.stateDir,
        "--config",
        configPath,
        "--delivery-timeout-ms",
        "4321",
        "codex",
      ],
      {
        stdin: JSON.stringify(codexPayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_codex_timeout",
        clientFactory: (_socketPath, options) => {
          observedTimeoutMs = options?.timeoutMs;
          if (options !== undefined && "expectedBuildVersion" in options) {
            observedBuildVersion = options.expectedBuildVersion;
          }
          const ingest = async (event: ProviderHookEvent): Promise<ProviderHookReceipt> => ({
            schemaVersion: "0.8.0",
            hookId: event.hookId ?? "hook_timeout_1",
            provider: event.provider,
            event: event.event,
            accepted: true,
            status: "ingested",
            receivedAt: event.receivedAt,
            reconciled: false,
          });
          return {
            health: async () => healthyObserver(fixture),
            ingestProviderHookEvent: ingest,
            ingestHookEvent: ingest,
          } as never;
        },
      },
    );

    expect(receipt.status).toBe("ingested");
    expect(observedTimeoutMs).toBe(4321);
    expect(observedBuildVersion).toBe(stationObserverBuildVersion());
  });

  it("spools raw Codex hook events when online delivery is unavailable", async () => {
    const fixture = await createTempState();

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "--no-auto-start", "codex"],
      {
        stdin: JSON.stringify(codexPayload()),
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "hook_codex_spooled",
        clientFactory: () => {
          const ingest = async (): Promise<ProviderHookReceipt> => {
            throw new Error("offline");
          };
          return {
            ingestProviderHookEvent: ingest,
            ingestHookEvent: ingest,
          } as never;
        },
      },
    );

    expect(receipt).toMatchObject({
      status: "spooled",
      provider: "codex",
      event: "PreToolUse",
    });
    const files = await listHookSpoolFiles(fixture.hookSpoolDir);
    expect(files).toHaveLength(1);
    const record = await readHookSpoolRecord(fixture.hookSpoolDir, files[0] ?? "");
    expect(record.event).toMatchObject({
      hookId: "hook_codex_spooled",
      provider: "codex",
      kind: "harness",
      event: "PreToolUse",
    });
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

  it("keeps malformed JSON rejected and visible at the CLI boundary", async () => {
    const fixture = await createTempState();

    const result = await runProviderIngressMain(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "codex"],
      { stdin: "{ invalid json", env: {} },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HOOK_PAYLOAD_INVALID");
  });

  it("rejects malformed provider payloads before delivery or spool writes", async () => {
    const fixture = await createTempState();
    let delivered = false;

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "codex"],
      {
        stdin: "{ invalid json",
        env: stationEnv(),
      },
      {
        clock: { now: () => new Date(now) },
        clientFactory: () => {
          const ingest = async (): Promise<ProviderHookReceipt> => {
            delivered = true;
            throw new Error("should not deliver invalid payloads");
          };
          return {
            ingestProviderHookEvent: ingest,
            ingestHookEvent: ingest,
          } as never;
        },
      },
    );

    expect(receipt).toMatchObject({
      status: "rejected",
      error: {
        code: "HOOK_PAYLOAD_INVALID",
      },
    });
    expect(delivered).toBe(false);
    await expect(listHookSpoolFiles(fixture.hookSpoolDir)).resolves.toEqual([]);
  });
});

function codexPayload() {
  return {
    session_id: "codex_session_1",
    transcript_path: null,
    cwd: "/tmp/station/web/task",
    hook_event_name: "PreToolUse",
    model: "gpt-5.4-codex",
    permission_mode: "default",
    turn_id: "turn_1",
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    tool_use_id: "call_test",
  };
}

function claudePayload() {
  return {
    session_id: "claude_session_1",
    transcript_path: "/home/user/.claude/projects/-tmp-station-web-task/claude_session_1.jsonl",
    cwd: "/tmp/station/web/task",
    hook_event_name: "PreToolUse",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    tool_use_id: "toolu_test",
  };
}

function cursorPayload() {
  return {
    hook_event_name: "beforeShellExecution",
    session_id: "cursor_session_1",
    conversation_id: "conversation_1",
    workspace_roots: ["/tmp/station/web/task"],
    model: "cursor-model",
    cursor_version: "2026.06.02-8c11d9f",
    tool_name: "shell",
    command: "pnpm test",
    tool_input: { command: "pnpm test" },
    user_email: "person@example.com",
  };
}

function stationEnv(): Record<string, string> {
  return {
    STATION_PROJECT_ID: "web",
    STATION_WORKTREE_ID: "wt_web_task",
    STATION_WORKTREE_PATH: "/tmp/station/web/task",
    STATION_SESSION_ID: "ses_web_task",
    STATION_TERMINAL_PROVIDER: "tmux",
    STATION_TERMINAL_TARGET_ID: "tmux:station:@1:%2",
  };
}

type IngressDeps = NonNullable<Parameters<typeof runProviderIngressCommand>[2]>;

type ObserverWorkCalls = {
  client: number;
  health: number;
  delivery: number;
  startup: number;
  spool: number;
  log: number;
};

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

function observerWorkForbiddenDeps(
  logger: JsonlLogger,
  hookId: string,
): { deps: IngressDeps; calls: ObserverWorkCalls } {
  const calls: ObserverWorkCalls = {
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
          throw new Error("correlation failures must not probe Observer health");
        },
        ingestProviderHookEvent: async () => {
          calls.delivery += 1;
          throw new Error("correlation failures must not reach Observer delivery");
        },
      } as never;
    },
    spawnObserver: async () => {
      calls.startup += 1;
      throw new Error("correlation failures must not start the Observer");
    },
    writeSpool: async () => {
      calls.spool += 1;
      throw new Error("correlation failures must not be spooled");
    },
    logger: countedLogger,
  };
  return { deps, calls };
}

function healthyObserver(paths: { socketPath: string; stateDir: string }): ObserverHealth {
  return {
    schemaVersion: "0.8.0",
    status: "healthy",
    pid: 12345,
    startedAt: now,
    version: stationObserverBuildVersion(),
    socketPath: paths.socketPath,
    stateDir: paths.stateDir,
  };
}
