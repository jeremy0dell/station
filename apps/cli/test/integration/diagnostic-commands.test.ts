import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runCli } from "@station/cli";
import { observerRuntimeFreshnessCheck, rendererRuntimeCheck } from "@station/cli/internal";
import type { DiagnosticEvidenceIndex, DiagnosticSnapshot, DoctorReport } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";

describe("CLI diagnostic commands", () => {
  it("routes doctor through the observer diagnostics API", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const deps = {
      clientFactory: () =>
        ({
          health: async () => ({
            schemaVersion: "0.6.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: "0.0.0",
          }),
          runDoctor: async () => doctorReport(fixture.stateDir),
        }) as never,
      sleep: async () => undefined,
    };

    await expect(
      runCli(["--config", configPath, "doctor"], { observerDeps: deps }),
    ).resolves.toMatchObject({
      code: 0,
      output: {
        schemaVersion: "0.6.0",
        status: "healthy",
        debugBundle: {
          available: true,
        },
      },
    });
  });

  it("reports stale local observer runtime evidence without restarting anything", async () => {
    await expect(observerRuntimeFreshnessCheck("2000-01-01T00:00:00.000Z")).resolves.toMatchObject({
      name: "observer-runtime-freshness",
      status: "warn",
      error: {
        code: "OBSERVER_RUNTIME_STALE",
      },
    });
  });

  it("warns when Bun is missing because bare stn cannot render the TUI", async () => {
    await expect(rendererRuntimeCheck(async () => undefined)).resolves.toMatchObject({
      name: "renderer-runtime",
      status: "warn",
      error: { code: "BUN_RUNTIME_MISSING" },
    });
  });

  it("stays silent when Bun is resolvable", async () => {
    await expect(rendererRuntimeCheck(async () => "/usr/local/bin/bun")).resolves.toBeUndefined();
  });

  it("stays silent when a STATION_DASHBOARD_COMMAND override replaces bun run", async () => {
    await expect(
      rendererRuntimeCheck(async () => undefined, "my-renderer --foo"),
    ).resolves.toBeUndefined();
  });

  it("collects diagnostics and writes a debug bundle", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const deps = {
      clientFactory: () =>
        ({
          health: async () => ({
            schemaVersion: "0.6.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: "0.0.0",
          }),
          collectDiagnostics: async () => diagnosticSnapshot(),
        }) as never,
      sleep: async () => undefined,
    };

    const result = await runCli(["--config", configPath, "debug", "bundle"], {
      observerDeps: deps,
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        manifest: {
          sections: expect.arrayContaining(["manifest.json", "commands.jsonl"]),
        },
      },
    });
    const bundlePath = (result.output as { bundlePath: string }).bundlePath;
    await expect(readFile(join(bundlePath, "manifest.json"), "utf8")).resolves.toContain("diag_");
  });

  it("lets debug bundle diagnostics exceed the old one second collection budget", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const deps = {
      clientFactory: () =>
        ({
          health: async () => ({
            schemaVersion: "0.6.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: "0.0.0",
          }),
          collectDiagnostics: async () => {
            await sleep(1100);
            return diagnosticSnapshot();
          },
        }) as never,
      sleep: async () => undefined,
    };

    await expect(
      runCli(["--config", configPath, "debug", "bundle"], {
        observerDeps: deps,
      }),
    ).resolves.toMatchObject({
      code: 0,
      output: {
        manifest: {
          sections: expect.arrayContaining(["manifest.json"]),
        },
      },
    });
  });

  it("passes trace and latest-failure filters to debug bundle collection", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    let collectedOptions: unknown;
    const deps = {
      clientFactory: () =>
        ({
          health: async () => ({
            schemaVersion: "0.6.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: "0.0.0",
          }),
          collectDiagnostics: async (options: unknown) => {
            collectedOptions = options;
            return diagnosticSnapshot();
          },
        }) as never,
      sleep: async () => undefined,
    };

    await runCli(["--config", configPath, "debug", "bundle", "--trace", "trc_1"], {
      observerDeps: deps,
    });
    expect(collectedOptions).toMatchObject({ traceId: "trc_1" });

    await runCli(["--config", configPath, "debug", "bundle", "--latest-failure"], {
      observerDeps: deps,
    });
    expect(collectedOptions).toMatchObject({ latestFailure: true });
  });

  it("validates debug bundle filters before observer startup", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);

    await expect(
      runCli(["--config", configPath, "debug", "bundle", "--since", "not-a-date"], {
        observerDeps: {
          spawnObserver: async () => {
            throw new Error("observer should not start for invalid debug bundle filters");
          },
        },
      }),
    ).rejects.toThrow("Invalid debug bundle options");
  });

  it("validates doctor filters before observer startup", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);

    await expect(
      runCli(["--config", configPath, "doctor", "--project", ""], {
        observerDeps: {
          spawnObserver: async () => {
            throw new Error("observer should not start for invalid doctor filters");
          },
        },
      }),
    ).rejects.toThrow("--project requires a value.");
  });

  it("resolves debug trace IDs from existing bundles without observer RPC", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const deps = {
      clientFactory: () =>
        ({
          health: async () => ({
            schemaVersion: "0.6.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: "0.0.0",
          }),
          collectDiagnostics: async () => diagnosticSnapshot(),
        }) as never,
      sleep: async () => undefined,
    };

    await runCli(["--config", configPath, "debug", "bundle"], {
      observerDeps: deps,
    });
    const traced = await runCli(["--config", configPath, "debug", "trace", "trc_1"], {
      observerDeps: {
        clientFactory: () => {
          throw new Error("debug trace should not contact observer");
        },
      },
    });

    expect(traced).toMatchObject({
      code: 0,
      output: {
        matched: true,
        source: "bundle",
        matchedIdType: "traceId",
        command: { id: "cmd_1" },
      },
    });
  });

  it("resolves external command diagnostics and root causes from debug trace bundles", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const deps = {
      clientFactory: () =>
        ({
          health: async () => ({
            schemaVersion: "0.6.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: "0.0.0",
          }),
          collectDiagnostics: async () => failedWorktrunkDiagnosticSnapshot(),
        }) as never,
      sleep: async () => undefined,
    };

    await runCli(["--config", configPath, "debug", "bundle"], {
      observerDeps: deps,
    });
    const traced = await runCli(["--config", configPath, "debug", "trace", "cmd_worktrunk"], {
      observerDeps: {
        clientFactory: () => {
          throw new Error("debug trace should not contact observer");
        },
      },
    });

    expect(traced).toMatchObject({
      code: 0,
      output: {
        matched: true,
        source: "bundle",
        matchedIdType: "commandId",
        command: {
          id: "cmd_worktrunk",
          status: "failed",
          traceId: "trc_worktrunk",
        },
        error: {
          code: "WORKTRUNK_UNSUPPORTED_FLAG",
          provider: "worktrunk",
          diagnostics: [
            expect.objectContaining({
              type: "external_command",
              provider: "worktrunk",
              operation: "provider.worktrunk.switch",
              command: "wt switch --no-hooks --create feature --no-cd --format=json",
              cwd: "/tmp/station/web",
              exitCode: 2,
              stderrSnippet: "error: unexpected argument '--no-hooks' found",
              durationMs: 42,
            }),
          ],
        },
        rootCauseCodes: expect.arrayContaining(["WORKTRUNK_UNSUPPORTED_FLAG"]),
      },
    });
  });

  it("resolves latest debug trace failure from live logs without observer RPC", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    await mkdir(join(fixture.stateDir, "logs"), { recursive: true });
    await writeFile(
      join(fixture.stateDir, "logs", "observer.jsonl"),
      `${[
        JSON.stringify({
          timestamp: "2026-05-20T12:00:00.000Z",
          level: "error",
          component: "observer",
          message: "Command failed.",
          attributes: {
            commandId: "cmd_old",
            commandType: "session.create",
            traceId: "trc_old",
            error: { tag: "WorktreeProviderError", code: "OLD", message: "Old failure." },
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-20T12:01:00.000Z",
          level: "error",
          component: "observer",
          message: "Command failed.",
          attributes: {
            commandId: "cmd_new",
            commandType: "session.create",
            traceId: "trc_new",
            error: {
              tag: "WorktreeProviderError",
              code: "WORKTRUNK_BRANCH_EXISTS",
              message: "Branch exists.",
            },
          },
        }),
      ].join("\n")}\n`,
    );

    const traced = await runCli(["--config", configPath, "debug", "trace", "--latest-failure"], {
      observerDeps: {
        clientFactory: () => {
          throw new Error("debug trace should not contact observer");
        },
      },
    });

    expect(traced).toMatchObject({
      code: 0,
      output: {
        matched: true,
        source: "log",
        command: {
          id: "cmd_new",
          traceId: "trc_new",
        },
        error: {
          code: "WORKTRUNK_BRANCH_EXISTS",
        },
      },
    });
  });

  it("resolves CLI observer lifecycle failures from live logs", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    await mkdir(join(fixture.stateDir, "logs"), { recursive: true });
    await writeFile(
      join(fixture.stateDir, "logs", "cli.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-05-20T12:02:00.000Z",
        level: "error",
        component: "cli",
        message: "Observer lifecycle failed.",
        traceId: "trc_lifecycle",
        spanId: "spn_lifecycle",
        attributes: {
          operation: "cli.observer.start",
          error: {
            tag: "ObserverStartupError",
            code: "OBSERVER_START_FAILED",
            message: "Observer did not become healthy before the startup timeout.",
            traceId: "trc_lifecycle",
          },
        },
      })}\n`,
    );

    const traced = await runCli(["--config", configPath, "debug", "trace", "--latest-failure"], {
      observerDeps: {
        clientFactory: () => {
          throw new Error("debug trace should not contact observer");
        },
      },
    });

    expect(traced).toMatchObject({
      code: 0,
      output: {
        matched: true,
        source: "log",
        traceId: "trc_lifecycle",
        spanId: "spn_lifecycle",
        error: {
          code: "OBSERVER_START_FAILED",
        },
        suggestedCommands: expect.arrayContaining(["stn debug bundle --trace trc_lifecycle"]),
      },
    });
  });

  it("filters runtime logs without searching hook logs by default", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    await mkdir(join(fixture.stateDir, "logs"), { recursive: true });
    await writeFile(
      join(fixture.stateDir, "logs", "observer.jsonl"),
      `${[
        JSON.stringify({
          timestamp: "2026-05-20T12:00:00.000Z",
          level: "info",
          component: "observer",
          message: "Reconcile finished.",
        }),
        JSON.stringify({
          timestamp: "2026-05-20T12:01:00.000Z",
          level: "error",
          component: "observer",
          message: "Observer protocol payload failed validation.",
          attributes: {
            error: {
              tag: "ProtocolError",
              code: "PROTOCOL_VALIDATION_FAILED",
              message: "Observer protocol payload failed validation.",
            },
          },
        }),
      ].join("\n")}\n`,
    );
    await writeFile(
      join(fixture.stateDir, "logs", "hooks.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-05-20T12:02:00.000Z",
        level: "warn",
        component: "hook",
        message: "Observer protocol request timed out.",
      })}\n`,
    );

    const result = await runCli(["--config", configPath, "debug", "logs", "protocol"], {
      observerDeps: {
        clientFactory: () => {
          throw new Error("debug logs should not contact observer");
        },
      },
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        query: "protocol",
        components: ["observer", "cli", "tui"],
        matched: 1,
        records: [
          {
            component: "observer",
            level: "error",
            message: "Observer protocol payload failed validation.",
            error: {
              code: "PROTOCOL_VALIDATION_FAILED",
            },
          },
        ],
      },
    });
    const filesSearched = (result.output as { evidence: { filesSearched: string[] } }).evidence
      .filesSearched;
    expect(filesSearched).not.toContain(join(fixture.stateDir, "logs", "hooks.jsonl"));
  });

  it("can opt into hook log filtering", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    await mkdir(join(fixture.stateDir, "logs"), { recursive: true });
    await writeFile(
      join(fixture.stateDir, "logs", "hooks.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-05-20T12:02:00.000Z",
        level: "warn",
        component: "hook",
        message: "Observer protocol request timed out.",
        provider: "codex",
      })}\n`,
    );

    await expect(
      runCli(["--config", configPath, "debug", "logs", "protocol", "--component", "hook"]),
    ).resolves.toMatchObject({
      code: 0,
      output: {
        components: ["hook"],
        records: [
          {
            component: "hook",
            provider: "codex",
            message: "Observer protocol request timed out.",
          },
        ],
      },
    });
  });

  it("returns doctor diagnostics for an invalid config without starting the observer", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-invalid-config-"));
    const configPath = join(root, "config.toml");
    await writeFile(
      configPath,
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[defaults]",
        "worktree_provider = 42",
        'terminal = "fake-terminal"',
        'harness = "fake-harness"',
        'layout = "agent-shell"',
        "",
      ].join("\n"),
    );

    const result = await runCli(["--config", configPath, "doctor"], {
      observerDeps: {
        spawnObserver: async () => {
          throw new Error("observer should not start for invalid config doctor");
        },
      },
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "unavailable",
        config: {
          configPath,
          diagnostics: [
            expect.objectContaining({
              code: "CONFIG_VALIDATION_FAILED",
              diagnosticId: "config-load",
            }),
          ],
        },
      },
    });
  });

  it("writes a debug bundle for an invalid config without observer RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-invalid-debug-"));
    const stateDir = join(root, "state");
    const configPath = join(root, "config.toml");
    await writeFile(
      configPath,
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[observer]",
        `state_dir = ${JSON.stringify(stateDir)}`,
        "",
        "[defaults]",
        'worktree_provider = "fake-worktree"',
        "terminal = false",
        'harness = "fake-harness"',
        'layout = "agent-shell"',
        "",
      ].join("\n"),
    );

    const result = await runCli(["--config", configPath, "debug", "bundle"], {
      observerDeps: {
        clientFactory: () => {
          throw new Error("observer RPC should not be used for invalid config debug bundle");
        },
      },
    });

    expect(result.code).toBe(0);
    const bundlePath = (result.output as { bundlePath: string }).bundlePath;
    const index = JSON.parse(
      await readFile(join(bundlePath, "diagnostic-index.json"), "utf8"),
    ) as DiagnosticEvidenceIndex;
    expect(index.summary.rootCauseCodes).toContain("INVALID_CONFIG");
  });
});

function doctorReport(stateDir: string): DoctorReport {
  return {
    schemaVersion: "0.6.0",
    generatedAt: now,
    status: "healthy",
    checks: [{ name: "observer", status: "ok", message: "Observer is healthy." }],
    observer: {
      schemaVersion: "0.6.0",
      status: "healthy",
      pid: 1234,
      startedAt: now,
      version: "0.0.0",
    },
    config: { projectCount: 0, diagnostics: [] },
    providers: {},
    snapshot: diagnosticSnapshot().snapshot,
    logs: { paths: [], recent: [] },
    localState: {
      stateDir,
      totalBytes: 0,
      limitBytes: 262144000,
      overLimit: false,
      entries: [],
    },
    retention: diagnosticRetention(),
    recentErrors: [],
    debugBundle: {
      available: true,
      diagnosticsDir: join(stateDir, "diagnostics"),
    },
  };
}

function diagnosticSnapshot(): DiagnosticSnapshot {
  return {
    schemaVersion: "0.6.0",
    collectedAt: now,
    observerHealth: {
      schemaVersion: "0.6.0",
      status: "healthy",
      pid: 1234,
      startedAt: now,
      version: "0.0.0",
    },
    snapshot: {
      schemaVersion: "0.6.0",
      generatedAt: now,
      observer: { pid: 1234, startedAt: now, version: "0.0.0", healthy: true },
      providerHealth: {},
      projects: [],
      rows: [],
      sessions: [],
      counts: {
        projects: 0,
        worktrees: 0,
        agents: 0,
        working: 0,
        idle: 0,
        attention: 0,
        unknown: 0,
      },
      alerts: [],
    },
    providerHealth: {},
    commands: [
      {
        id: "cmd_1",
        type: "observer.reconcile",
        command: { type: "observer.reconcile", payload: { reason: "cli-test" } },
        status: "succeeded",
        createdAt: now,
        traceId: "trc_1",
        spanId: "spn_1",
      },
    ],
    events: [{ type: "command.succeeded", commandId: "cmd_1", traceId: "trc_1", spanId: "spn_1" }],
    errors: [],
    logs: [],
  };
}

function failedWorktrunkDiagnosticSnapshot(): DiagnosticSnapshot {
  const diagnostic = {
    type: "external_command",
    provider: "worktrunk",
    operation: "provider.worktrunk.switch",
    command: "wt switch --no-hooks --create feature --no-cd --format=json",
    cwd: "/tmp/station/web",
    exitCode: 2,
    stderrSnippet: "error: unexpected argument '--no-hooks' found",
    durationMs: 42,
  } as const;
  return {
    ...diagnosticSnapshot(),
    commands: [
      {
        id: "cmd_worktrunk",
        type: "session.create",
        command: {
          type: "session.create",
          payload: {
            projectId: "web",
            branch: "feature",
            harness: { provider: "codex" },
            terminal: { provider: "tmux", layout: "agent-build-shell" },
          },
        },
        status: "failed",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        traceId: "trc_worktrunk",
        spanId: "spn_worktrunk",
        error: {
          tag: "WorktreeProviderError",
          code: "WORKTRUNK_UNSUPPORTED_FLAG",
          message: "Worktrunk rejected an automation flag used by STATION.",
          provider: "worktrunk",
        },
        diagnostics: [diagnostic],
      },
    ],
    events: [
      {
        type: "command.failed",
        commandId: "cmd_worktrunk",
        traceId: "trc_worktrunk",
        spanId: "spn_worktrunk",
        error: {
          tag: "WorktreeProviderError",
          code: "WORKTRUNK_UNSUPPORTED_FLAG",
          message: "Worktrunk rejected an automation flag used by STATION.",
          provider: "worktrunk",
        },
      },
    ],
    errors: [
      {
        id: "err_worktrunk",
        tag: "WorktreeProviderError",
        code: "WORKTRUNK_UNSUPPORTED_FLAG",
        message: "Worktrunk rejected an automation flag used by STATION.",
        severity: "error",
        commandId: "cmd_worktrunk",
        traceId: "trc_worktrunk",
        spanId: "spn_worktrunk",
        provider: "worktrunk",
        diagnostics: [diagnostic],
        redacted: true,
        createdAt: now,
      },
    ],
  };
}

function diagnosticRetention() {
  return {
    maxDays: 14,
    maxTotalMb: 250,
    maxFileMb: 10,
    maxFilesPerComponent: 5,
    components: {
      observerMaxMb: 100,
      cliMaxMb: 25,
      tuiMaxMb: 25,
      hookRunnerMaxMb: 25,
      providerMaxMb: 75,
    },
    sqlite: {
      eventsMaxDays: 30,
      commandsMaxDays: 60,
      errorsMaxDays: 60,
      providerObservationsMaxDays: 14,
    },
    debugBundles: { maxBundles: 10, maxDays: 30 },
    hookSpool: {
      deliveredDeleteImmediately: true,
      failedMaxDays: 7,
      failedMaxItems: 1000,
    },
  };
}
