import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseCleanupArgs } from "../../scripts/maintenance/agent-cleanup.mjs";
import {
  isUnder,
  normalizeConfig,
  parseResetArgs,
} from "../../scripts/maintenance/agent-reset.mjs";
import {
  buildRuntimeInventory,
  formatRuntimeInventory,
  parseRuntimeInventoryArgs,
} from "../../scripts/maintenance/runtime-inventory.mjs";
import {
  buildSessionMigrationPlan,
  parseSessionMigrationArgs,
} from "../../scripts/maintenance/session-migrate.mjs";
import {
  assertSqliteTables,
  buildRecoveryCoverage,
  environmentWithoutGitLocals,
  parseSessionRescueArgs,
  verifySessionRescueArchive,
  writeSessionRescueManifest,
} from "../../scripts/maintenance/session-rescue.mjs";
import {
  buildGuidedVitestArgs,
  guidedConfigPath,
  guidedTestFiles,
  resolveVitestCommand,
} from "../../scripts/test-runners/run-setup-guided-e2e.mjs";
import {
  commandFromArgs,
  defaultDevSessionNameForRoot,
  globalOptionsFromArgs,
  isForeignLiveDevPopup,
  parseDevPopupOwnerPid,
  shouldKeepAliveAfterLauncherExit,
  shouldRunDirectTui,
} from "../../scripts/tui-dev.mjs";
import {
  createBuildIdentityRestartProbe,
  mouseReportingDisableSequence,
} from "../../scripts/tui-watch-runner.mjs";

const rescueMetadata = {
  configPath: "/tmp/source/config.toml",
  codexHome: "/tmp/source/codex",
  claudeProjectsRoot: "/tmp/source/claude/projects",
  opencodeDb: "/tmp/source/opencode.db",
  observerPaths: {
    stateDir: "/tmp/source/observer",
    socketPath: "/tmp/source/observer.sock",
    dbPath: "/tmp/source/observer.sqlite",
    logDir: "/tmp/source/logs",
    diagnosticsDir: "/tmp/source/diagnostics",
    hookSpoolDir: "/tmp/source/spool",
  },
  hostSocketPath: "/tmp/source/host.sock",
  stationVersion: "0.0.0-test",
  stationBuildIdentity: "test-build",
  observerBuildVersion: "0.0.0-test+station.test",
};

const turboConfigSchema = z.object({
  futureFlags: z
    .object({
      watchUsingTaskInputs: z.boolean().optional(),
    })
    .optional(),
  tasks: z
    .object({
      build: z
        .object({
          inputs: z.array(z.string()).optional(),
          outputs: z.array(z.string()).optional(),
        })
        .optional(),
      "build:identity": z
        .object({
          cache: z.boolean().optional(),
          dependsOn: z.array(z.string()).optional(),
          inputs: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});

const packageScriptsSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
});

const turboDryRunSchema = z.object({
  tasks: z
    .array(
      z.object({
        taskId: z.string().optional(),
        inputs: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
});

function runtimeOwnerProcess(pid = 999_999, osStartTime = "exited") {
  return {
    pid,
    pgid: pid,
    osStartTime,
    processToken: "11111111-1111-4111-8111-111111111111",
    executable: { path: process.execPath, device: "1", inode: "1" },
    script: { path: process.execPath, device: "1", inode: "1" },
  };
}

function runtimeOwnerRecord(root: string, overrides: Record<string, unknown> = {}) {
  const runtimeId = "run_11111111-1111-4111-8111-111111111111";
  const owner = runtimeOwnerProcess();
  return {
    schemaVersion: 1,
    generation: 0,
    runtimeId,
    role: "native-hmr",
    disposition: "disposable",
    runtimeKey: "a".repeat(64),
    launchKey: "b".repeat(64),
    checkout: { root, key: "c".repeat(64), device: "1", inode: "1" },
    recordRoot: join(root, "run", "runtime-owners", "v1"),
    owner,
    processGroup: owner,
    correlation: { traceId: "trc_runtime_inventory", spanId: "spn_runtime_inventory" },
    socketRoots: [join(root, "run")],
    persistenceRoots: [root],
    survivorPolicy: "preserve-persistent-station-runtime",
    state: { phase: "running" },
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function writeRuntimeRecord(root: string, record: ReturnType<typeof runtimeOwnerRecord>) {
  const directory = join(root, "run", "runtime-owners", "v1");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, `${record.runtimeId}.json`), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}

function writeLifecycleEvent(root: string, record: ReturnType<typeof runtimeOwnerRecord>) {
  const directory = join(root, "logs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, "cli.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-08-08T00:01:00.000Z",
      level: "warn",
      component: "cli",
      message: "runtime.cleanup.refused",
      traceId: record.correlation.traceId,
      spanId: record.correlation.spanId,
      attributes: {
        runtimeId: record.runtimeId,
        role: record.role,
        disposition: record.disposition,
        runtimeKey: record.runtimeKey,
        checkoutKey: record.checkout.key,
        socketRootsKey: "d".repeat(64),
        persistenceRootsKey: "e".repeat(64),
        survivorPolicy: record.survivorPolicy,
        ownerPid: record.owner.pid,
        ownerStartTime: record.owner.osStartTime,
        groupLeaderPid: record.processGroup.pid,
        pgid: record.processGroup.pgid,
        groupStartTime: record.processGroup.osStartTime,
        refusalCode: "RUNTIME_OWNER_OWNER_IDENTITY_AMBIGUOUS",
      },
    })}\n`,
    { mode: 0o600 },
  );
}

async function waitForRuntimeOwnerRecord(directory: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const recordName = existsSync(directory)
      ? readdirSync(directory).find((entry) => entry.endsWith(".json"))
      : undefined;
    if (recordName !== undefined) {
      const record = JSON.parse(readFileSync(join(directory, recordName), "utf8")) as ReturnType<
        typeof runtimeOwnerRecord
      >;
      if (record.processGroup !== undefined) return record;
    }
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for runtime owner record under: ${directory}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

async function waitForExit(child: ReturnType<typeof spawn>) {
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

describe("agent cleanup/reset scripts", () => {
  it("defaults cleanup and reset to dry-run mode", () => {
    expect(parseCleanupArgs([])).toMatchObject({
      dryRun: true,
      realE2e: true,
      localObserver: true,
      tmux: true,
    });
    expect(parseResetArgs([])).toMatchObject({
      dryRun: true,
      forceWorktrees: false,
      projectId: "station",
    });
  });

  it("parses explicit destructive reset flags", () => {
    expect(
      parseResetArgs(["--yes", "--force-worktrees", "--project-id", "protocol", "--state"]),
    ).toMatchObject({
      dryRun: false,
      forceWorktrees: true,
      projectId: "protocol",
      state: true,
    });
  });

  it("ignores pnpm argument separators", () => {
    expect(parseCleanupArgs(["--", "--yes"])).toMatchObject({
      dryRun: false,
    });
    expect(parseResetArgs(["--", "--yes"])).toMatchObject({
      dryRun: false,
    });
  });

  it("normalizes stale local real config without requiring a default Codex profile", () => {
    const input = `[harness.codex]
profile = "default"
sandbox = "workspace-write"

[worktree.worktrunk]
command = "wt"

[projects.worktrunk]
managed_root = ".worktrees"
include_external = false
`;

    const output = normalizeConfig(input);

    expect(output).toContain('managed_root = "~/.worktrees"');
    expect(output).toContain('sandbox = "workspace-write"');
    expect(output).not.toContain('profile = "default"');
    expect(output).not.toContain('managed_root = ".worktrees"');
    expect(output.indexOf('managed_root = "~/.worktrees"')).toBeLessThan(
      output.indexOf("[projects.worktrunk]"),
    );
  });

  it("adds a global managed root when the worktrunk section is missing", () => {
    expect(normalizeConfig("[projects]\n")).toContain(`[worktree.worktrunk]
managed_root = "~/.worktrees"`);
  });

  it("checks managed roots without prefix false positives", () => {
    expect(isUnder("/tmp/station/.worktrees/branch", "/tmp/station/.worktrees")).toBe(true);
    expect(isUnder("/tmp/station/.worktrees-other/branch", "/tmp/station/.worktrees")).toBe(false);
  });
});

describe("runtime inventory script", () => {
  it("reads valid evidence without exposing roots or mutating records", async () => {
    const root = mkdtempSync(join(tmpdir(), "station-runtime-inventory-"));
    const secret = "do-not-print-this-private-root";
    const record = runtimeOwnerRecord(root, {
      socketRoots: [join(root, secret, "socket")],
      persistenceRoots: [join(root, secret, "state")],
    });
    try {
      writeRuntimeRecord(root, record);
      writeLifecycleEvent(root, record);
      const recordPath = join(root, "run", "runtime-owners", "v1", `${record.runtimeId}.json`);
      const before = readFileSync(recordPath, "utf8");

      const inventory = await buildRuntimeInventory({ stateDir: root });
      const rendered = JSON.stringify(inventory);

      expect(inventory).toMatchObject({
        mode: "read-only",
        ownerRecords: { state: "available", count: 1 },
        runtimes: [
          expect.objectContaining({
            role: "native-hmr",
            disposition: "disposable",
            liveness: "exited",
            lifecycle: expect.objectContaining({
              event: "runtime.cleanup.refused",
              traceId: record.correlation.traceId,
              log: "logs/cli.jsonl",
            }),
          }),
        ],
      });
      expect(rendered).not.toContain(root);
      expect(rendered).not.toContain(secret);
      expect(formatRuntimeInventory(inventory)).toContain("read-only");
      expect(readFileSync(recordPath, "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags stale, PID-reused, ambiguous, and missing ownership evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "station-runtime-inventory-refusals-"));
    try {
      const reused = runtimeOwnerRecord(root, {
        owner: runtimeOwnerProcess(process.pid, "not-this-process"),
        processGroup: runtimeOwnerProcess(process.pid, "not-this-process"),
      });
      writeRuntimeRecord(root, reused);
      const ownerDirectory = join(root, "run", "runtime-owners", "v1");
      writeFileSync(
        join(ownerDirectory, "run_22222222-2222-4222-8222-222222222222.json"),
        "{bad\n",
        {
          mode: 0o600,
        },
      );
      const inventory = await buildRuntimeInventory({ stateDir: root });

      expect(inventory.runtimes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: "refused",
            liveness: "refused",
            refusalReasons: expect.arrayContaining(["owner-changed"]),
          }),
          expect.objectContaining({
            state: "refused",
            refusalCode: "RUNTIME_OWNER_RECORD_MALFORMED",
          }),
        ]),
      );

      writeFileSync(join(ownerDirectory, "unexpected"), "ambiguous\n", { mode: 0o600 });
      expect(await buildRuntimeInventory({ stateDir: root })).toMatchObject({
        ownerRecords: {
          state: "refused",
          refusalCode: "RUNTIME_OWNER_DIRECTORY_AMBIGUOUS",
        },
      });

      const missing = await buildRuntimeInventory({ stateDir: join(root, "missing") });
      expect(missing.ownerRecords).toMatchObject({ state: "missing", count: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies active and owner-lost disposable groups without touching either", async () => {
    const root = mkdtempSync(join(tmpdir(), "station-runtime-inventory-live-"));
    const runner = join(root, "owner.mjs");
    const recordDirectory = join(root, "run", "runtime-owners", "v1");
    let owner: ReturnType<typeof spawn> | undefined;
    let processGroup: number | undefined;
    try {
      writeFileSync(
        runner,
        [
          `import { runOwnedDisposableRuntime } from ${JSON.stringify(new URL("../../scripts/runtime-owner.mjs", import.meta.url).href)};`,
          `await runOwnedDisposableRuntime({ role: "native-hmr", checkoutRoot: ${JSON.stringify(process.cwd())}, stateDir: ${JSON.stringify(root)}, socketRoots: [${JSON.stringify(join(root, "run"))}], persistenceRoots: [${JSON.stringify(root)}], survivorPolicy: "preserve-persistent-station-runtime", terminalKey: "inventory-live", correlation: { traceId: "trc_inventory_live", spanId: "spn_inventory_live" }, launch: { cwd: ${JSON.stringify(process.cwd())}, steps: [{ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }] } });`,
        ].join("\n"),
        { mode: 0o600 },
      );
      owner = spawn(process.execPath, [runner], { stdio: "ignore" });
      const record = await waitForRuntimeOwnerRecord(recordDirectory);
      const recordPath = join(recordDirectory, `${record.runtimeId}.json`);
      processGroup = record.processGroup.pgid;

      const active = await buildRuntimeInventory({ stateDir: root });
      expect(active.runtimes).toEqual(
        expect.arrayContaining([expect.objectContaining({ liveness: "active" })]),
      );
      expect(owner.exitCode).toBeNull();

      owner.kill("SIGKILL");
      await waitForExit(owner);
      owner = undefined;
      const orphaned = await buildRuntimeInventory({ stateDir: root });
      expect(orphaned.runtimes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ liveness: "orphaned", state: "inspectable" }),
        ]),
      );
      expect(readFileSync(recordPath, "utf8")).toContain(record.runtimeId);
    } finally {
      if (owner?.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      if (processGroup !== undefined) {
        try {
          process.kill(-processGroup, "SIGTERM");
        } catch {
          // The disposable fixture already exited.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("accepts only explicit read-only inventory arguments", () => {
    expect(parseRuntimeInventoryArgs(["--json", "--state-dir", "/tmp/station-state"])).toEqual({
      json: true,
      stateDir: "/tmp/station-state",
    });
    expect(() => parseRuntimeInventoryArgs(["--run"])).toThrow("Unknown runtime inventory option");
    expect(() => parseRuntimeInventoryArgs(["--state-dir", "relative"])).toThrow(
      "requires an absolute path",
    );
  });
});

describe("session migration script", () => {
  it("defaults to a read-only plan and requires --yes for full migration", () => {
    vi.stubEnv("CODEX_HOME", undefined);
    vi.stubEnv("XDG_DATA_HOME", undefined);
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);

    expect(
      parseSessionMigrationArgs(["--archive", "rescue", "--target-config", "target.toml"], {
        cwd: "/tmp",
        homeDir: "/Users/example",
      }),
    ).toMatchObject({
      command: "plan",
      archivePath: "/tmp/rescue",
      targetConfig: "/tmp/target.toml",
      targetCodexHome: "/Users/example/.codex",
    });
    const digest = "a".repeat(64);
    expect(
      parseSessionMigrationArgs(
        ["--archive", "rescue", "--target-config", "target.toml", "--yes", "--expect-plan", digest],
        { cwd: "/tmp", homeDir: "/Users/example" },
      ),
    ).toMatchObject({ command: "apply", expectPlan: digest });
    expect(() =>
      parseSessionMigrationArgs(
        ["--archive", "rescue", "--target-config", "target.toml", "--yes"],
        { cwd: "/tmp", homeDir: "/Users/example" },
      ),
    ).toThrow("--yes requires --expect-plan");
    expect(() =>
      parseSessionMigrationArgs([
        "--archive",
        "rescue",
        "--target-config",
        "target.toml",
        "--source-config",
        "source.toml",
        "--source-devbox-root",
        "/repo",
      ]),
    ).toThrow("Use --source-config or --source-devbox-root, not both");
  });

  it("does not edit target config or write target SQLite directly", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../scripts/maintenance/session-migrate.mjs", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("enableSessionResumeFeature");
    expect(source).not.toContain("INSERT INTO session_recovery_handles");
    expect(source).not.toContain("atomicReplace(options.targetConfig");
    expect(source).toContain("SessionMigrationSealSchema");
    expect(source).toContain("SessionMigrationLockSchema");
    expect(source).toContain("loadResumableMigration");
    expect(source.indexOf("await quiesceSource")).toBeLessThan(
      source.indexOf('type: "session.importRecoveryHandle"'),
    );
    expect(source.lastIndexOf("await verifySealedProviderState")).toBeLessThan(
      source.indexOf('phase = "staging-target"'),
    );
  });

  it("maps one exact archived recovery handle onto the same empty target worktree", () => {
    const handle = {
      id: "rec_codex",
      provider: "codex",
      projectId: "station",
      worktreeId: "wt_station_feature",
      sessionId: "ses_feature",
      target: { kind: "native-session" as const, id: "thread-1" },
      cwd: "/worktrees/feature",
      observedAt: "2026-07-29T12:00:00.000Z",
      lastSeenAt: "2026-07-29T12:00:00.000Z",
    };
    const row = {
      id: "wt_station_feature",
      projectId: "station",
      path: "/worktrees/feature",
      title: "Feature",
    };
    const plan = buildSessionMigrationPlan(
      [
        {
          sessionId: "ses_feature",
          provider: "codex",
          projectId: "station",
          worktreeId: row.id,
          exactHandleIds: [handle.id],
          candidateHandleIds: [],
        },
      ],
      [handle],
      {
        rows: [row],
        sessions: [
          {
            id: "ses_feature",
            title: "PR #365 · session rescue",
            projectId: "station",
            worktreeId: row.id,
          },
        ],
      },
      { rows: [row], sessions: [] },
    );

    expect(plan).toEqual([
      expect.objectContaining({
        sessionId: "ses_feature",
        title: "PR #365 · session rescue",
        worktreePath: "/worktrees/feature",
        handle,
      }),
    ]);
  });

  it("refuses migration when the target worktree already owns a session", () => {
    const coverage = [
      {
        sessionId: "ses_source",
        provider: "codex",
        projectId: "station",
        worktreeId: "wt_station_feature",
        exactHandleIds: ["rec_source"],
        candidateHandleIds: [],
      },
    ];
    const handles = [
      {
        id: "rec_source",
        provider: "codex",
        projectId: "station",
        worktreeId: "wt_station_feature",
        sessionId: "ses_source",
        target: { kind: "native-session" as const, id: "thread-1" },
        cwd: "/worktrees/feature",
      },
    ];
    const row = {
      id: "wt_station_feature",
      projectId: "station",
      path: "/worktrees/feature",
    };
    const source = {
      rows: [row],
      sessions: [
        {
          id: "ses_source",
          title: "Source",
          projectId: "station",
          worktreeId: row.id,
        },
      ],
    };
    expect(() =>
      buildSessionMigrationPlan(coverage, handles, source, {
        rows: [row],
        sessions: [
          {
            id: "ses_target",
            projectId: "station",
            worktreeId: row.id,
          },
        ],
      }),
    ).toThrow("Target worktree already has a session");

    expect(
      buildSessionMigrationPlan(
        coverage,
        handles,
        source,
        {
          rows: [row],
          sessions: [
            {
              id: "ses_source",
              projectId: "station",
              worktreeId: row.id,
              harness: { provider: "codex" },
            },
          ],
        },
        { allowMatchingTargetSessions: true },
      ),
    ).toEqual([expect.objectContaining({ sessionId: "ses_source", alreadyResumed: true })]);
  });
});

describe("session rescue script", () => {
  it("resolves devbox inputs while keeping the archive outside disposable state", () => {
    const options = parseSessionRescueArgs(["save", "--devbox"], {
      cwd: "/repo/station",
      homeDir: "/Users/example",
      now: new Date("2026-07-29T16:00:00.000Z"),
    });

    expect(options).toMatchObject({
      command: "save",
      configPath: "/repo/station/.dev-state/config.toml",
      codexHome: "/repo/station/.dev-state/codex-home",
      claudeProjectsRoot: "/repo/station/.dev-state/claude-home/projects",
      outputPath: "/Users/example/.local/state/station-session-rescues/2026-07-29T16-00-00-000Z",
    });
    expect(() =>
      parseSessionRescueArgs(["save", "--devbox", "--config", "/tmp/config.toml"]),
    ).toThrow("--devbox cannot be combined with --config, --codex-home, or --claude-config-dir");
  });

  it("removes repository-local Git variables before worktree capture", () => {
    expect(
      environmentWithoutGitLocals({
        PATH: "/bin",
        GIT_DIR: "/wrong/.git",
        GIT_WORK_TREE: "/wrong",
        GIT_INDEX_FILE: "/wrong/index",
      }),
    ).toEqual({ PATH: "/bin" });
  });

  it("reports candidate handles without treating them as exact recovery coverage", () => {
    const coverage = buildRecoveryCoverage(
      [
        {
          kind: "agent",
          alive: true,
          ptyId: "pty-1",
          sessionId: "ses_new",
          harnessProvider: "codex",
          projectId: "station",
          worktreeId: "wt_station_a",
          terminalTargetId: "native:wt_station_a",
        },
      ],
      undefined,
      [
        {
          id: "rec_old",
          provider: "codex",
          projectId: "station",
          worktreeId: "wt_station_a",
          sessionId: "ses_old",
          terminalTargetId: "native:wt_station_a",
        },
      ],
    );

    expect(coverage).toEqual([
      expect.objectContaining({
        sessionId: "ses_new",
        exactHandleIds: [],
        candidateHandleIds: ["rec_old"],
      }),
    ]);
  });

  it("rejects a SQLite file from the wrong provider", () => {
    const root = mkdtempSync(join(tmpdir(), "station-session-provider-db-"));
    const path = join(root, "provider.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    database.close();

    try {
      expect(() => assertSqliteTables(path, ["session"])).not.toThrow();
      expect(() => assertSqliteTables(path, ["threads"])).toThrow(
        "SQLite backup is missing required table: threads",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects archive payload tampering", async () => {
    const root = mkdtempSync(join(tmpdir(), "station-session-archive-"));

    try {
      writeFileSync(join(root, "snapshot.json"), "{}\n");
      await writeSessionRescueManifest(root, {
        status: "complete",
        warnings: [],
        critical: [],
        metadata: rescueMetadata,
      });
      await expect(verifySessionRescueArchive(root)).resolves.toMatchObject({ ok: true });

      writeFileSync(join(root, "snapshot.json"), '{"changed":true}\n');
      const verification = await verifySessionRescueArchive(root);
      expect(verification.ok).toBe(false);
      expect(verification.errors).toContain("Hash mismatch: snapshot.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal paths and incomplete archives without reading outside them", async () => {
    const root = mkdtempSync(join(tmpdir(), "station-session-archive-boundary-"));

    try {
      writeFileSync(
        join(root, "manifest.json"),
        `${JSON.stringify({
          archiveVersion: 1,
          createdAt: "2026-07-30T12:00:00.000Z",
          status: "partial",
          warnings: [],
          critical: ["incomplete"],
          metadata: rescueMetadata,
          files: [
            {
              path: "../outside",
              type: "file",
              size: 1,
              sha256: "a".repeat(64),
            },
          ],
        })}\n`,
      );
      writeFileSync(join(root, "INCOMPLETE"), "unfinished\n");

      const verification = await verifySessionRescueArchive(root);
      expect(verification.ok).toBe(false);
      expect(verification.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Unsafe archive path"),
          "Archive is marked INCOMPLETE",
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow archive symlink ancestors during verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "station-session-archive-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "station-session-archive-outside-"));

    try {
      writeFileSync(join(outside, "secret"), "outside\n");
      symlinkSync(outside, join(root, "escape"));
      writeFileSync(
        join(root, "manifest.json"),
        `${JSON.stringify({
          archiveVersion: 1,
          createdAt: "2026-07-30T12:00:00.000Z",
          status: "partial",
          warnings: [],
          critical: ["symlink"],
          metadata: rescueMetadata,
          files: [
            {
              path: "escape/secret",
              type: "file",
              size: 8,
              sha256: "a".repeat(64),
            },
          ],
        })}\n`,
      );

      const verification = await verifySessionRescueArchive(root);
      expect(verification.ok).toBe(false);
      expect(verification.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("symlink ancestor")]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("binary smoke script", () => {
  it("reaps a detached Observer when cancellation lands during startup", () => {
    const scriptPath = fileURLToPath(
      new URL("../../scripts/test-runners/run-binary-smoke.mjs", import.meta.url),
    );
    const reaped = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, STATION_BINARY_SMOKE_CANCELLATION_SELF_CHECK: "1" },
      encoding: "utf8",
    });
    expect(reaped.status, reaped.stderr).toBe(0);

    const interrupted = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, STATION_BINARY_SMOKE_CANCELLATION_EXIT_SELF_CHECK: "1" },
      stdio: "pipe",
    });
    expect(interrupted.status).toBe(130);
  });

  it("preserves the primary failure and cancellation while retaining external evidence", () => {
    const scriptPath = fileURLToPath(
      new URL("../../scripts/test-runners/run-binary-smoke.mjs", import.meta.url),
    );
    const parent = mkdtempSync(join(tmpdir(), "station-binary-evidence-process-"));
    try {
      const failedEvidence = join(parent, "failed-evidence");
      const failed = spawnSync(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          STATION_BINARY_SMOKE_EVIDENCE_DIR: failedEvidence,
          STATION_BINARY_SMOKE_EVIDENCE_FAILURE_SELF_CHECK: "1",
        },
        encoding: "utf8",
      });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("synthetic binary smoke evidence failure");
      const failedManifest = JSON.parse(
        readFileSync(join(failedEvidence, "manifest.json"), "utf8"),
      );
      expect(failedManifest.status).toBe("failed");
      expect(failedManifest.rounds[0].cleanup.status).toBe("complete");
      expect(failedManifest.rounds[0].failure.message).toBe(
        "synthetic binary smoke evidence failure",
      );
      expect(failedManifest.rounds[0].runtime.lifecycle).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "runtime.cleanup.completed",
            attributes: expect.objectContaining({
              memberCount: 0,
            }),
          }),
        ]),
      );

      const captureFailed = spawnSync(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          STATION_BINARY_SMOKE_EVIDENCE_DIR: "relative-evidence",
          STATION_BINARY_SMOKE_EVIDENCE_FAILURE_SELF_CHECK: "1",
        },
        encoding: "utf8",
      });
      expect(captureFailed.status).toBe(1);
      expect(captureFailed.stderr).toContain("STATION_BINARY_SMOKE_EVIDENCE_DIR must be absolute");
      expect(captureFailed.stderr).not.toContain("synthetic binary smoke evidence failure");

      const cleanupFailedEvidence = join(parent, "cleanup-failed-evidence");
      const cleanupFailed = spawnSync(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          STATION_BINARY_SMOKE_CLEANUP_FAILURE_SELF_CHECK: "1",
          STATION_BINARY_SMOKE_EVIDENCE_DIR: cleanupFailedEvidence,
          STATION_BINARY_SMOKE_EVIDENCE_FAILURE_SELF_CHECK: "1",
        },
        encoding: "utf8",
      });
      expect(cleanupFailed.status).toBe(1);
      expect(cleanupFailed.stderr).toContain("synthetic binary smoke evidence failure");
      expect(cleanupFailed.stderr).toContain(
        "Binary smoke warning: cleanup self-check: synthetic binary smoke cleanup failure",
      );
      const cleanupFailedManifest = JSON.parse(
        readFileSync(join(cleanupFailedEvidence, "manifest.json"), "utf8"),
      );
      expect(cleanupFailedManifest.rounds[0].cleanup.status).toBe("complete");
      expect(cleanupFailedManifest.warnings).toContain(
        "cleanup self-check: synthetic binary smoke cleanup failure",
      );

      const cancelledEvidence = join(parent, "cancelled-evidence");
      const cancelled = spawnSync(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          STATION_BINARY_SMOKE_CANCELLATION_EXIT_SELF_CHECK: "1",
          STATION_BINARY_SMOKE_EVIDENCE_DIR: cancelledEvidence,
        },
        encoding: "utf8",
      });
      expect(cancelled.status).toBe(130);
      const cancelledManifest = JSON.parse(
        readFileSync(join(cancelledEvidence, "manifest.json"), "utf8"),
      );
      expect(cancelledManifest.status).toBe("cancelled");
      expect(cancelledManifest.rounds[0].cleanup.status).toBe("complete");
      expect(existsSync(cancelledEvidence)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 15_000);

  it("validates the focused handoff-stress flags before building artifacts", () => {
    const scriptPath = fileURLToPath(
      new URL("../../scripts/test-runners/run-binary-smoke.mjs", import.meta.url),
    );
    const invalidVersion = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--mode",
        "handoff-stress",
        "--expected-version",
        "not-semver",
        "--rounds",
        "50",
        "--round-timeout-ms",
        "30000",
      ],
      { encoding: "utf8" },
    );
    expect(invalidVersion.status).toBe(1);
    expect(invalidVersion.stderr).toContain("--expected-version must be a SemVer value");

    const excessiveRounds = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--mode",
        "handoff-stress",
        "--expected-version",
        "0.0.0-local",
        "--rounds",
        "1001",
      ],
      { encoding: "utf8" },
    );
    expect(excessiveRounds.status).toBe(1);
    expect(excessiveRounds.stderr).toContain("--rounds must be between 1 and 1000");
  });
});

describe("binary smoke runtime ownership", () => {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/test-runners/run-binary-smoke.mjs", import.meta.url),
  );

  type OwnershipDescriptor = {
    root: string;
    ownerStateDir: string;
    runId: string;
    innerPid: number;
    pids: { observer: number; stationHost: number; popupRenderer: number };
  };

  function startOwnershipRun(
    descriptorPath: string,
    options: {
      evidenceDir?: string;
      exitImmediately?: boolean;
      replaceRoot?: boolean;
      termResistant?: boolean;
    } = {},
  ) {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        STATION_BINARY_SMOKE_OWNERSHIP_TEST_DESCRIPTOR: descriptorPath,
        ...(options.evidenceDir === undefined
          ? {}
          : { STATION_BINARY_SMOKE_EVIDENCE_DIR: options.evidenceDir }),
        ...(options.exitImmediately
          ? { STATION_BINARY_SMOKE_OWNERSHIP_TEST_EXIT_IMMEDIATELY: "1" }
          : {}),
        ...(options.replaceRoot ? { STATION_BINARY_SMOKE_OWNERSHIP_TEST_REPLACE_ROOT: "1" } : {}),
        ...(options.termResistant
          ? { STATION_BINARY_SMOKE_OWNERSHIP_TEST_TERM_RESISTANT: "1" }
          : {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.setEncoding("utf8");
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    return { child, exited, stderr: () => stderr };
  }

  async function waitForDescriptor(path: string): Promise<OwnershipDescriptor> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (existsSync(path)) {
        try {
          return JSON.parse(readFileSync(path, "utf8")) as OwnershipDescriptor;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ownership descriptor ${path}`);
  }

  function processGroup(pid: number): number {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return Number(result.stdout.trim());
  }

  async function expectProcessesGone(pids: number[]) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        })
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Owned processes remained: ${pids.join(", ")}`);
  }

  function assertFinalEvidence(path: string, expectedStatus: "failed" | "cancelled") {
    const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
    expect(manifest.status).toBe(expectedStatus);
    expect(manifest.runId).toMatch(/^run_/);
    expect(manifest.rounds[0].cleanup).toEqual({
      status: "complete",
      observerExited: true,
      hostExited: true,
      socketRemoved: true,
      pidfileRemoved: true,
      hostSocketRemoved: true,
      rootRemoved: true,
    });
    expect(
      manifest.rounds[0].runtime.processes.every((entry: { exists: boolean }) => !entry.exists),
    ).toBe(true);
    return manifest;
  }

  it("refuses a caller-forged inner mode and an existing evidence destination before spawn", () => {
    const parent = mkdtempSync(join(tmpdir(), "station-binary-owner-boundary-"));
    try {
      const descriptorPath = join(parent, "descriptor.json");
      const forged = spawnSync(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          STATION_BINARY_SMOKE_OWNED_CHILD: "1",
          STATION_BINARY_SMOKE_OWNER_STATE_DIR: parent,
          STATION_BINARY_SMOKE_OWNERSHIP_TEST_DESCRIPTOR: descriptorPath,
          STATION_RUNTIME_OWNER_ID: "run_11111111-1111-4111-8111-111111111111",
        },
        encoding: "utf8",
      });
      expect(forged.status).toBe(1);
      expect(forged.stderr).toContain("not corroborated by an active exact owner record");
      expect(existsSync(descriptorPath)).toBe(false);

      const evidencePath = join(parent, "existing-evidence");
      writeFileSync(evidencePath, "caller-owned\n", { mode: 0o600 });
      const existing = spawnSync(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          STATION_BINARY_SMOKE_EVIDENCE_DIR: evidencePath,
          STATION_BINARY_SMOKE_OWNERSHIP_TEST_DESCRIPTOR: descriptorPath,
          STATION_BINARY_SMOKE_OWNERSHIP_TEST_EXIT_IMMEDIATELY: "1",
        },
        encoding: "utf8",
      });
      expect(existing.status).toBe(1);
      expect(existing.stderr).toContain("must not exist");
      expect(readFileSync(evidencePath, "utf8")).toBe("caller-owned\n");
      expect(existsSync(descriptorPath)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reaps the real outer topology for all signals, inner SIGKILL, and escalation", async () => {
    const parent = mkdtempSync(join(tmpdir(), "station-binary-owner-signals-"));
    let activeRun: ReturnType<typeof startOwnershipRun> | undefined;
    try {
      const cases = [
        { name: "int", signal: "SIGINT", status: 130, evidenceStatus: "cancelled" },
        { name: "term", signal: "SIGTERM", status: 143, evidenceStatus: "cancelled" },
        { name: "hup", signal: "SIGHUP", status: 129, evidenceStatus: "cancelled" },
        { name: "inner-kill", signal: "INNER_SIGKILL", status: 137, evidenceStatus: "failed" },
        {
          name: "term-resistant",
          signal: "SIGTERM",
          status: 143,
          evidenceStatus: "cancelled",
          termResistant: true,
        },
      ] as const;
      for (const testCase of cases) {
        const descriptorPath = join(parent, `${testCase.name}.json`);
        const evidenceDir = join(parent, `${testCase.name}-evidence`);
        const run = startOwnershipRun(descriptorPath, {
          evidenceDir,
          termResistant: "termResistant" in testCase && testCase.termResistant,
        });
        activeRun = run;
        const descriptor = await waitForDescriptor(descriptorPath);
        const pids = [descriptor.innerPid, ...Object.values(descriptor.pids)];
        expect(new Set(pids.map(processGroup)).size).toBe(1);
        if (testCase.signal === "INNER_SIGKILL") process.kill(descriptor.innerPid, "SIGKILL");
        else run.child.kill(testCase.signal);
        await run.exited;
        activeRun = undefined;
        expect(run.child.exitCode, run.stderr()).toBe(testCase.status);
        await expectProcessesGone(pids);
        expect(existsSync(descriptor.root)).toBe(false);
        expect(readdirSync(join(descriptor.ownerStateDir, "run/runtime-owners/v1"))).toEqual([]);
        const manifest = assertFinalEvidence(evidenceDir, testCase.evidenceStatus);
        const lifecycle = manifest.rounds[0].runtime.lifecycle;
        expect(lifecycle.map((event: { message: string }) => event.message)).toEqual(
          expect.arrayContaining(["runtime.cleanup.completed", "runtime.owner.retired"]),
        );
        if ("termResistant" in testCase && testCase.termResistant) {
          expect(lifecycle).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                message: "runtime.cleanup.escalated",
                attributes: expect.objectContaining({ signal: "SIGKILL" }),
              }),
            ]),
          );
        }
      }
    } finally {
      if (activeRun?.child.exitCode === null && activeRun.child.signalCode === null) {
        activeRun.child.kill("SIGTERM");
        await activeRun.exited.catch(() => undefined);
      }
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  it("records incomplete cleanup and preserves a replaced root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "station-binary-owner-replaced-root-"));
    const descriptorPath = join(parent, "descriptor.json");
    const evidenceDir = join(parent, "evidence");
    const run = startOwnershipRun(descriptorPath, {
      evidenceDir,
      exitImmediately: true,
      replaceRoot: true,
    });
    try {
      await run.exited;
      expect(run.child.exitCode).toBe(1);
      const descriptor = await waitForDescriptor(descriptorPath);
      expect(readFileSync(join(descriptor.root, "replacement-sentinel"), "utf8")).toBe(
        "preserve\n",
      );
      const manifest = JSON.parse(readFileSync(join(evidenceDir, "manifest.json"), "utf8"));
      expect(manifest.rounds[0].cleanup).toMatchObject({
        status: "incomplete",
        rootRemoved: false,
      });
      expect(manifest.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("Refusing replaced deletion target")]),
      );
      rmSync(descriptor.root, { recursive: true, force: true });
      rmSync(`${descriptor.root}-original`, { recursive: true, force: true });
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGTERM");
      await run.exited.catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
    }
  }, 15_000);

  it("rescues launcher loss on the next ordinary invocation without a rescue variable", async () => {
    const parent = mkdtempSync(join(tmpdir(), "station-binary-owner-rescue-"));
    const firstDescriptorPath = join(parent, "first.json");
    const secondDescriptorPath = join(parent, "second.json");
    const first = startOwnershipRun(firstDescriptorPath);
    try {
      const abandoned = await waitForDescriptor(firstDescriptorPath);
      first.child.kill("SIGKILL");
      await first.exited;
      expect(first.child.signalCode).toBe("SIGKILL");

      const second = startOwnershipRun(secondDescriptorPath, { exitImmediately: true });
      await second.exited;
      expect(second.child.exitCode, second.stderr()).toBe(0);
      const replacement = await waitForDescriptor(secondDescriptorPath);
      await expectProcessesGone([abandoned.innerPid, ...Object.values(abandoned.pids)]);
      expect(existsSync(abandoned.root)).toBe(false);
      expect(existsSync(replacement.root)).toBe(false);
      expect(readdirSync(join(abandoned.ownerStateDir, "run/runtime-owners/v1"))).toEqual([]);
      const lifecycle = readFileSync(join(abandoned.ownerStateDir, "logs/cli.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { message: string });
      expect(lifecycle.map((event) => event.message)).toEqual(
        expect.arrayContaining(["runtime.orphan.detected", "runtime.orphan.recovered"]),
      );
    } finally {
      if (first.child.exitCode === null && first.child.signalCode === null)
        first.child.kill("SIGTERM");
      await first.exited.catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("tui dev script", () => {
  it("keeps default tmux popup mode alive after the opener exits", () => {
    expect(commandFromArgs(["--config", "/tmp/station.toml"])).toBeUndefined();
    expect(globalOptionsFromArgs(["--config", "/tmp/station.toml", "popup"])).toEqual([
      "--config",
      "/tmp/station.toml",
    ]);
    expect(shouldRunDirectTui([], { TMUX: "/tmp/tmux-501/default,123,0" })).toBe(false);
    expect(shouldKeepAliveAfterLauncherExit([], { TMUX: "/tmp/tmux-501/default,123,0" })).toBe(
      true,
    );
    expect(
      shouldKeepAliveAfterLauncherExit(["--config", "/tmp/station.toml", "popup"], {
        TMUX: "/tmp/tmux-501/default,123,0",
      }),
    ).toBe(true);
  });

  it("uses a checkout-scoped default dev UI session name", () => {
    const main = defaultDevSessionNameForRoot("/Users/example/Developer/station");
    const worktree = defaultDevSessionNameForRoot("/Users/example/.worktrees/station/tui-layout");

    expect(main).toMatch(/^_station-ui-dev-station-[a-f0-9]{8}$/);
    expect(worktree).toMatch(/^_station-ui-dev-tui-layout-[a-f0-9]{8}$/);
    expect(main).not.toBe(worktree);
  });

  it("detects a live dev popup registered by another checkout", () => {
    expect(parseDevPopupOwnerPid("12345:timestamp:token")).toBe(12345);
    expect(parseDevPopupOwnerPid("not-a-pid:timestamp")).toBeUndefined();

    expect(
      isForeignLiveDevPopup(
        {
          currentRoot: "/worktrees/current",
          root: "/worktrees/other",
          owner: "12345:timestamp:token",
          sessionName: "_station-ui-dev-other",
        },
        (pid) => pid === 12345,
      ),
    ).toBe(true);
    expect(
      isForeignLiveDevPopup(
        {
          currentRoot: "/worktrees/current",
          root: "/worktrees/current",
          owner: "12345:timestamp:token",
          sessionName: "_station-ui-dev-current",
        },
        () => true,
      ),
    ).toBe(false);
    expect(
      isForeignLiveDevPopup(
        {
          currentRoot: "/worktrees/current",
          root: "/worktrees/other",
          owner: "12345:timestamp:token",
          sessionName: "_station-ui-dev-other",
        },
        () => false,
      ),
    ).toBe(false);
  });

  it("does not keep direct TUI or one-shot utility commands alive", () => {
    expect(shouldRunDirectTui([], {})).toBe(true);
    expect(shouldRunDirectTui(["tui"], { TMUX: "/tmp/tmux-501/default,123,0" })).toBe(true);
    expect(shouldKeepAliveAfterLauncherExit(["tui"], { TMUX: "/tmp/tmux-501/default,123,0" })).toBe(
      false,
    );
    expect(
      shouldKeepAliveAfterLauncherExit(["observer", "stop"], {
        TMUX: "/tmp/tmux-501/default,123,0",
      }),
    ).toBe(false);
  });

  it("restarts the dev TUI only after a new verified build identity is published", () => {
    const root = mkdtempSync(join(tmpdir(), "station-tui-watch-"));
    const identityPath = join(root, "station-build-id");
    const firstIdentity = "a".repeat(64);
    const secondIdentity = "b".repeat(64);
    writeFileSync(identityPath, `${firstIdentity}\n`);
    const shouldRestart = createBuildIdentityRestartProbe(identityPath);

    try {
      expect(shouldRestart(join(root, "main.js"))).toBe(false);
      expect(shouldRestart(undefined)).toBe(false);
      rmSync(identityPath);
      expect(shouldRestart(identityPath)).toBe(false);
      writeFileSync(identityPath, `${firstIdentity}\n`);
      expect(shouldRestart(undefined)).toBe(true);
      expect(shouldRestart(identityPath)).toBe(false);
      writeFileSync(identityPath, "invalid\n");
      expect(shouldRestart(undefined)).toBe(false);
      writeFileSync(identityPath, `${secondIdentity}\n`);
      expect(shouldRestart(undefined)).toBe(true);
      expect(shouldRestart(identityPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resets terminal mouse reporting after TUI child exits", () => {
    expect(mouseReportingDisableSequence).toContain("\u001B[?1000l");
    expect(mouseReportingDisableSequence).toContain("\u001B[?1002l");
    expect(mouseReportingDisableSequence).toContain("\u001B[?1003l");
    expect(mouseReportingDisableSequence).toContain("\u001B[?1005l");
    expect(mouseReportingDisableSequence).toContain("\u001B[?1006l");
    expect(mouseReportingDisableSequence).toContain("\u001B[?1015l");
  });

  it("routes both native HMR development commands through the shared owner", () => {
    const rootPackageResult = packageScriptsSchema.safeParse(
      JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")),
    );
    const stationPackageResult = packageScriptsSchema.safeParse(
      JSON.parse(readFileSync(new URL("../../station/package.json", import.meta.url), "utf8")),
    );
    expect(rootPackageResult.success).toBe(true);
    expect(stationPackageResult.success).toBe(true);
    if (!rootPackageResult.success || !stationPackageResult.success) return;
    const rootPackage = rootPackageResult.data;
    const stationPackage = stationPackageResult.data;
    const isolatedScript = readFileSync(
      new URL("../../station/scripts/station-isolated.sh", import.meta.url),
      "utf8",
    );
    const devboxScript = readFileSync(
      new URL("../../scripts/station-devbox.mjs", import.meta.url),
      "utf8",
    );
    const nodePtyRepairScript = readFileSync(
      new URL("../../station/scripts/repair-node-pty.sh", import.meta.url),
      "utf8",
    );

    expect(rootPackage.scripts?.["station:ui-dev"]).toBe("cd station && bun run dev");
    expect(rootPackage.scripts?.["station:runtime-inventory"]).toBe(
      "node scripts/maintenance/runtime-inventory.mjs",
    );
    expect(stationPackage.scripts?.dev).toBe("node ../scripts/native-hmr-runner.mjs");
    expect(stationPackage.scripts?.["station:isolated"]).toBe("./scripts/station-isolated.sh");
    expect(stationPackage.scripts?.["station:isolated"]).not.toContain("link:station");
    expect(stationPackage.scripts?.["station:isolated"]).not.toContain("repair:node-pty");
    expect(stationPackage.scripts?.station).toContain("./scripts/link-station-packages.sh");
    expect(stationPackage.scripts?.station).toContain("./scripts/repair-node-pty.sh");
    expect(nodePtyRepairScript).toMatch(/cd \\"\$\{root\}\\" && bun install --frozen-lockfile/u);

    const frozenInstall = isolatedScript.indexOf("bun install --frozen-lockfile");
    expect(isolatedScript).toContain('if [ "$COMMAND" = "inventory" ]');
    expect(isolatedScript.indexOf('if [ "$COMMAND" = "inventory" ]')).toBeLessThan(frozenInstall);
    expect(frozenInstall).toBeGreaterThan(isolatedScript.indexOf('if [ "$COMMAND" = "stop" ]'));
    expect(frozenInstall).toBeLessThan(isolatedScript.indexOf('mkdir -p "$DS/observer"'));
    expect(frozenInstall).toBeLessThan(isolatedScript.indexOf("observer start 2>&1"));
    expect(isolatedScript).toContain("exec bun run dev");
    expect(devboxScript).toContain('run("bun", ["run", "station:isolated", "dev"]');
    expect(stationPackage.scripts?.dev).not.toContain("bun --hot");
  });

  it("routes setup guided E2E entrypoints through the supervised owner", () => {
    const rootPackageResult = packageScriptsSchema.safeParse(
      JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")),
    );
    expect(rootPackageResult.success).toBe(true);
    if (!rootPackageResult.success) return;
    const rootPackage = rootPackageResult.data;

    expect(rootPackage.scripts?.["test:e2e:setup:guided"]).toBe(
      "node scripts/test-runners/run-setup-guided-e2e.mjs",
    );
    expect(rootPackage.scripts?.["test:e2e:setup:guided"]).not.toContain("vitest");
    expect(rootPackage.scripts?.["test:e2e:setup:guided:all-shells"]).toBe(
      "STATION_SETUP_E2E_ALL_SHELLS=true pnpm test:e2e:setup:guided",
    );

    expect(guidedTestFiles).toEqual([
      "tests/e2e/setup-guided-feedback.test.ts",
      "tests/e2e/setup-guided-tty.test.ts",
      "tests/e2e/setup-guided-sandbox.test.ts",
    ]);
    expect(buildGuidedVitestArgs()).toEqual([
      "run",
      "--config",
      guidedConfigPath,
      ...guidedTestFiles,
    ]);
    expect(buildGuidedVitestArgs(["-t", "writes multiple selected agent CLIs"])).toEqual([
      "run",
      "--config",
      guidedConfigPath,
      ...guidedTestFiles,
      "-t",
      "writes multiple selected agent CLIs",
    ]);

    const isolatedRoot = mkdtempSync(join(tmpdir(), "station-guided-runner-"));
    try {
      expect(resolveVitestCommand({ STATION_SETUP_E2E_VITEST_BIN: "/tmp/stub-vitest" })).toBe(
        "/tmp/stub-vitest",
      );
      expect(resolveVitestCommand({}, isolatedRoot)).toBe("vitest");
      expect(resolveVitestCommand({}, fileURLToPath(new URL("../../", import.meta.url)))).toBe(
        join(fileURLToPath(new URL("../../", import.meta.url)), "node_modules", ".bin", "vitest"),
      );
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("keeps turbo build watch inputs from reacting to tests", () => {
    const turboConfigResult = turboConfigSchema.safeParse(
      JSON.parse(readFileSync(new URL("../../turbo.json", import.meta.url), "utf8")),
    );
    const cliPackageResult = packageScriptsSchema.safeParse(
      JSON.parse(readFileSync(new URL("../../apps/cli/package.json", import.meta.url), "utf8")),
    );
    expect(turboConfigResult.success).toBe(true);
    expect(cliPackageResult.success).toBe(true);
    if (!turboConfigResult.success || !cliPackageResult.success) return;
    const turboConfig = turboConfigResult.data;
    const cliPackage = cliPackageResult.data;

    expect(turboConfig.tasks?.build?.inputs).toEqual(
      expect.arrayContaining([
        "$TURBO_DEFAULT$",
        "!test/**",
        "!tests/**",
        "!src/**/__tests__/**",
        "!**/*.test.ts",
        "!**/*.test.tsx",
      ]),
    );
    expect(turboConfig.tasks?.build?.outputs).toContain("!dist/station-build-id");
    expect(turboConfig.futureFlags?.watchUsingTaskInputs).toBe(true);
    expect(turboConfig.tasks?.["build:identity"]).toMatchObject({
      cache: false,
      dependsOn: ["^build"],
      inputs: turboConfig.tasks?.build?.inputs,
    });
    expect(cliPackage.scripts?.["build:identity"]).toBe("node ../../scripts/build-identity.mjs");

    const dryRunProcess = spawnSync(
      "pnpm",
      ["exec", "turbo", "run", "build:identity", "--filter=@station/cli", "--dry=json"],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        encoding: "utf8",
      },
    );
    expect(dryRunProcess.status, dryRunProcess.stderr).toBe(0);
    const dryRunResult = turboDryRunSchema.safeParse(JSON.parse(dryRunProcess.stdout));
    expect(dryRunResult.success).toBe(true);
    if (!dryRunResult.success) return;
    const dryRun = dryRunResult.data;
    const identityTask = dryRun.tasks?.find(
      (task) => task.taskId === "@station/cli#build:identity",
    );
    expect(Object.keys(identityTask?.inputs ?? {})).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/(^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.tsx?$/u),
      ]),
    );
  });
});
