import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

      const captureFailed = spawnSync(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          STATION_BINARY_SMOKE_EVIDENCE_DIR: "relative-evidence",
          STATION_BINARY_SMOKE_EVIDENCE_FAILURE_SELF_CHECK: "1",
        },
        encoding: "utf8",
      });
      expect(captureFailed.status).toBe(1);
      expect(captureFailed.stderr).toContain("synthetic binary smoke evidence failure");
      expect(captureFailed.stderr).toContain(
        "Evidence capture failed: STATION_BINARY_SMOKE_EVIDENCE_DIR must be absolute",
      );

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
      expect(cleanupFailedManifest.rounds[0].cleanup.status).toBe("incomplete");
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
  });

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

    expect(rootPackage.scripts?.["station:ui-dev"]).toBe("cd station && bun run dev");
    expect(stationPackage.scripts?.dev).toBe("node ../scripts/native-hmr-runner.mjs");
    expect(isolatedScript).toContain("exec bun run dev");
    expect(devboxScript).toContain('run("bun", ["run", "station:isolated", "dev"]');
    expect(stationPackage.scripts?.dev).not.toContain("bun --hot");
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
