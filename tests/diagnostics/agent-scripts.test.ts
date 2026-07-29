import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCleanupArgs } from "../../scripts/maintenance/agent-cleanup.mjs";
import {
  isUnder,
  normalizeConfig,
  parseResetArgs,
} from "../../scripts/maintenance/agent-reset.mjs";
import {
  assertSqliteTables,
  buildRecoveryCoverage,
  findCodexSessionAssets,
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

type TurboConfig = {
  futureFlags?: {
    watchUsingTaskInputs?: boolean;
  };
  tasks?: {
    build?: {
      inputs?: string[];
      outputs?: string[];
    };
    "build:identity"?: {
      cache?: boolean;
      dependsOn?: string[];
      inputs?: string[];
    };
  };
};

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
      outputPath: "/Users/example/.local/state/station-session-rescues/2026-07-29T16-00-00-000Z",
    });
    expect(() =>
      parseSessionRescueArgs(["save", "--devbox", "--config", "/tmp/config.toml"]),
    ).toThrow("--devbox cannot be combined with --config or --codex-home");
  });

  it("selects only exact Codex session and shell snapshot ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "station-session-assets-"));
    const id = "019faf49-9be1-7123-80a4-6c62539a907b";
    const exactSession = join(root, "sessions", "2026", "07", "29", `rollout-now-${id}.jsonl`);
    const nearSession = join(root, "sessions", "2026", "07", "29", `rollout-now-${id}-copy.jsonl`);
    const exactSnapshot = join(root, "shell_snapshots", `${id}.123.sh`);
    const nearSnapshot = join(root, "shell_snapshots", `${id}-copy.123.sh`);

    try {
      mkdirSync(join(root, "sessions", "2026", "07", "29"), { recursive: true });
      mkdirSync(join(root, "shell_snapshots"), { recursive: true });
      for (const path of [exactSession, nearSession, exactSnapshot, nearSnapshot]) {
        writeFileSync(path, "saved\n");
      }

      await expect(findCodexSessionAssets(root, id)).resolves.toEqual(
        new Set([exactSession, exactSnapshot]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      await writeSessionRescueManifest(root, { status: "complete", warnings: [] });
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
          status: "partial",
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
          status: "partial",
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
    execFileSync(process.execPath, [scriptPath], {
      env: { ...process.env, STATION_BINARY_SMOKE_CANCELLATION_SELF_CHECK: "1" },
      stdio: "pipe",
    });

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

  it("keeps turbo build watch inputs from reacting to tests", () => {
    const turboConfig = JSON.parse(
      readFileSync(new URL("../../turbo.json", import.meta.url), "utf8"),
    ) as TurboConfig;
    const cliPackage = JSON.parse(
      readFileSync(new URL("../../apps/cli/package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

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

    const dryRun = JSON.parse(
      execFileSync(
        "pnpm",
        ["exec", "turbo", "run", "build:identity", "--filter=@station/cli", "--dry=json"],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          encoding: "utf8",
        },
      ),
    ) as { tasks?: Array<{ taskId?: string; inputs?: Record<string, string> }> };
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
