import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_WORKSPACE_CONFIG } from "@station/config";
import { sameObservedPath } from "@station/contracts";
import { environmentWithoutGitLocals } from "@station/runtime";
import {
  installWorktrunkHooks,
  uninstallWorktrunkHooks,
  WorktrunkProvider,
} from "@station/worktrunk";
import { afterEach, describe, expect, it } from "vitest";
import { CleanupStack } from "../support/real-station/process";
import { writeConfigToml } from "../support/temp-projects";

const execFileAsync = promisify(execFile);
const runReal = process.env.STATION_REAL_WORKTRUNK === "1";
const describeReal = runReal ? describe : describe.skip;

describeReal("real Worktrunk provider smoke", () => {
  let cleanup: CleanupStack | undefined;

  afterEach(async () => {
    const pendingCleanup = cleanup;
    cleanup = undefined;
    await pendingCleanup?.run();
  });

  it("lists, creates, removes, and installs hooks against an isolated config", async () => {
    const wt = process.env.STATION_WORKTRUNK_BIN ?? "wt";
    await execFileAsync(wt, ["--version"]);

    const root = await mkdtemp(join(tmpdir(), "station-real-wt-"));
    cleanup = new CleanupStack();
    // LIFO teardown keeps the isolated root available for Observer and Worktrunk cleanup.
    cleanup.defer(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, "repo");
    const worktrunkConfigPath = join(root, "worktrunk", "config.toml");
    const stationBin = join(process.cwd(), "bin", "stn");
    const stationIngressBin = join(process.cwd(), "bin", "stn-ingress");
    const stateDir = join(root, "station-state");
    const observerSocketPath = join(root, "run", "observer.sock");
    const stationConfigPath = await writeConfigToml(root, {
      schemaVersion: 1,
      observer: {
        stateDir,
        socketPath: observerSocketPath,
        autoStartFromHooks: false,
      },
      defaults: {
        worktreeProvider: "noop-worktree",
        terminal: "noop-terminal",
        harness: "noop-harness",
        layout: "agent-shell",
      },
      projects: [],
      workspace: DEFAULT_WORKSPACE_CONFIG,
    });
    const hookExpectation = {
      hookBin: stationIngressBin,
      stationConfigPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir: join(stateDir, "spool", "hooks"),
      autoStartFromHooks: false,
    };
    cleanup.defer(async () => {
      const observerStarted = await access(observerSocketPath).then(
        () => true,
        () => false,
      );
      if (!observerStarted) return;
      await execFileAsync(stationBin, ["--config", stationConfigPath, "observer", "stop"]);
    });
    const branch = `station-real-${Date.now()}`;
    const git = (...args: string[]) =>
      execFileAsync("git", args, { cwd: repo, env: environmentWithoutGitLocals() });
    await mkdir(repo, { recursive: true });
    await git("init", "-b", "main");
    await git("config", "user.email", "station@example.invalid");
    await git("config", "user.name", "station");
    await git("commit", "--allow-empty", "-m", "initial");

    const provider = new WorktrunkProvider({
      command: wt,
      configPath: worktrunkConfigPath,
      timeoutMs: 15000,
      hookExpectation,
    });
    const project = {
      id: "real",
      label: "real",
      root: repo,
      defaults: {
        harness: "codex",
        terminal: "tmux",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
        base: "main",
      },
    };

    const hookOptions = {
      worktrunkConfigPath,
      expectation: hookExpectation,
    };
    await installWorktrunkHooks(hookOptions);
    cleanup.defer(async () => {
      await uninstallWorktrunkHooks(hookOptions);
    });

    let createdForCleanup:
      | { id: string; path: string; branch: string; registrationIdentity: string }
      | undefined;
    cleanup.defer(async () => {
      if (createdForCleanup === undefined) return;
      await provider.removeWorktree({
        worktreeId: createdForCleanup.id,
        expectedPath: createdForCleanup.path,
        expectedBranch: createdForCleanup.branch,
        expectedRegistrationIdentity: createdForCleanup.registrationIdentity,
        force: true,
      });
    });

    await expect(provider.health()).resolves.toMatchObject({ status: "healthy" });
    await expect(provider.listWorktrees(project)).resolves.toEqual(expect.any(Array));
    const created = await provider.createWorktree({ project, branch });
    if (created.registrationIdentity === undefined) {
      throw new Error("Expected the created worktree registration identity.");
    }
    createdForCleanup = { ...created, registrationIdentity: created.registrationIdentity };
    expect(created.branch).toBe(branch);
    await expect(
      provider.removeWorktree({
        worktreeId: created.id,
        expectedPath: created.path,
        expectedBranch: created.branch,
        expectedRegistrationIdentity: created.registrationIdentity,
      }),
    ).resolves.toMatchObject({ removed: true });
    createdForCleanup = undefined;
    await expect(access(observerSocketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only the selected linked checkout when the root shares its branch", async () => {
    const wt = process.env.STATION_WORKTRUNK_BIN ?? "wt";
    await execFileAsync(wt, ["--version"]);

    const root = await mkdtemp(join(tmpdir(), "station-real-wt-duplicate-"));
    const repo = join(root, "repo");
    const linked = join(root, "linked");
    const worktrunkConfigPath = join(root, "worktrunk", "config.toml");
    const git = (...args: string[]) =>
      execFileAsync("git", args, { cwd: repo, env: environmentWithoutGitLocals() });

    try {
      await mkdir(repo, { recursive: true });
      await mkdir(join(root, "worktrunk"), { recursive: true });
      await writeFile(worktrunkConfigPath, "");
      await git("init", "-b", "main");
      await git("config", "user.email", "station@example.invalid");
      await git("config", "user.name", "station");
      await git("commit", "--allow-empty", "-m", "initial");
      await git("branch", "duplicate");
      await git("worktree", "add", linked, "duplicate");
      await git("switch", "--ignore-other-worktrees", "duplicate");

      const provider = new WorktrunkProvider({
        command: wt,
        configPath: worktrunkConfigPath,
        useLifecycleHooks: false,
        timeoutMs: 15000,
      });
      const project = {
        id: "duplicate",
        label: "duplicate",
        root: repo,
        defaults: {
          harness: "codex" as const,
          terminal: "tmux" as const,
          layout: "agent-shell" as const,
        },
        worktrunk: {
          enabled: true,
          base: "main",
        },
      };

      const listed = await provider.listWorktrees(project);
      const selected = listed.find((worktree) => sameObservedPath(worktree.path, linked));
      expect(selected).toBeDefined();
      if (selected === undefined) throw new Error("Expected the linked worktree to be listed.");
      if (selected.registrationIdentity === undefined) {
        throw new Error("Expected the linked worktree registration identity.");
      }

      await expect(
        provider.removeWorktree({
          worktreeId: selected.id,
          expectedPath: selected.path,
          expectedBranch: selected.branch,
          expectedRegistrationIdentity: selected.registrationIdentity,
        }),
      ).resolves.toMatchObject({ removed: true });

      const remaining = await git("worktree", "list", "--porcelain");
      const remainingPaths = remaining.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
      expect(remainingPaths).toHaveLength(1);
      expect(remainingPaths.some((path) => sameObservedPath(path, repo))).toBe(true);
      expect(remainingPaths.some((path) => sameObservedPath(path, linked))).toBe(false);
      await expect(access(linked)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(git("branch", "--show-current")).resolves.toMatchObject({
        stdout: "duplicate\n",
      });
      await expect(git("show-ref", "--verify", "refs/heads/duplicate")).resolves.toMatchObject({
        stdout: expect.stringContaining("refs/heads/duplicate"),
      });
      await expect(git("config", "--local", "--get", "core.bare")).resolves.toMatchObject({
        stdout: "false\n",
      });
      await expect(git("rev-parse", "--is-bare-repository")).resolves.toMatchObject({
        stdout: "false\n",
      });
      await expect(git("status", "--porcelain=v1")).resolves.toMatchObject({ stdout: "" });
    } finally {
      await git("worktree", "remove", "--force", linked).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
