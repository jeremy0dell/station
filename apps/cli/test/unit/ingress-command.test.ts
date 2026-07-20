import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObserverHealth, ProviderHookEvent, ProviderHookReceipt } from "@station/contracts";
import { stationObserverBuildVersion } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { createRealStaleSocket } from "../../../../tests/support/sockets";
import {
  fileExists,
  listHookSpoolFiles,
  readHookSpoolRecord,
} from "../../../../tests/support/spool";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import { runProviderIngressCommand } from "../../src/ingress/command.js";

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

describe("provider hook ingress command", () => {
  it("turns raw observer flags into one finalized startup command", async () => {
    const fixture = await createTempState();
    const observerEntry = join(fixture.root, "custom-observer.js");
    await createRealStaleSocket(fixture.socketPath);
    let running = false;
    let staleSocketPresentAtSpawn = false;
    let spawnInput:
      | Parameters<NonNullable<Parameters<typeof runProviderIngressCommand>[2]["spawnObserver"]>>[0]
      | undefined;

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
          },
        },
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

  it("delivers Claude events without station ownership env when the payload has a cwd", async () => {
    const fixture = await createTempState();

    const receipt = await runProviderIngressCommand(
      ["--socket", fixture.socketPath, "--state-dir", fixture.stateDir, "claude"],
      {
        stdin: JSON.stringify(claudePayload()),
        env: {},
      },
      {
        clock: { now: () => new Date(now) },
        hookId: () => "report_claude_unowned_1",
      },
    );

    // External sessions must reach the observer (spooled here — none is
    // running) so cwd correlation can light their worktree row.
    expect(receipt).toMatchObject({
      status: "spooled",
      provider: "claude",
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

  it("delivers an env-less Claude event whose cwd falls under a configured project root", async () => {
    const fixture = await createTempState();
    // The project root must exist on disk; the payload cwd is compared as a
    // string, so a subdir of the root need not exist.
    const configPath = await writeConfigWithProject(fixture.root, fixture.root);

    const receipt = await runProviderIngressCommand(
      ["--config", configPath, "--no-auto-start", "claude"],
      {
        stdin: JSON.stringify({ ...claudePayload(), cwd: join(fixture.root, "web", "task") }),
        env: {},
      },
      { clock: { now: () => new Date(now) }, hookId: () => "report_claude_in_root" },
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
          observedTimeoutMs = options.timeoutMs;
          observedBuildVersion = options.expectedBuildVersion;
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
