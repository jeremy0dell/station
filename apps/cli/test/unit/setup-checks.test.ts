import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type {
  ExternalCommandInput,
  ExternalCommandResult,
  ExternalCommandRunner,
} from "@station/runtime";
import { buildManagedFastPopupRunShellCommand } from "@station/tmux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSetupBun } from "../../src/commands/setup/checks/bun.js";
import { setupProbeTimeoutMs } from "../../src/commands/setup/checks/constants.js";
import { checkSetupDiffnav } from "../../src/commands/setup/checks/diffnav.js";
import { checkSetupGit } from "../../src/commands/setup/checks/git.js";
import { checkSetupGitDelta } from "../../src/commands/setup/checks/gitDelta.js";
import { checkSetupLaunchers } from "../../src/commands/setup/checks/launchers.js";
import { checkSetupStateDir } from "../../src/commands/setup/checks/stateDir.js";
import {
  checkSetupSocketEvidence,
  collectSetupFacts,
} from "../../src/commands/setup/checks/system.js";
import {
  checkSetupTmuxBinding,
  tmuxPopupBindingBlock,
  tmuxPopupRunShellCommand,
} from "../../src/commands/setup/checks/tmuxBinding.js";
import { checkSetupXcode } from "../../src/commands/setup/checks/xcode.js";
import { buildSetupPlan } from "../../src/commands/setup/planner.js";

describe("setup dependency checks", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("creates and proves a writable private state directory", async () => {
    const root = await tempRoot(tempRoots);
    const path = join(root, "state");

    await expect(checkSetupStateDir({ path, probeName: ".probe" })).resolves.toEqual({
      status: "ok",
      path,
    });
  });

  it("checks the canonical lsof path used for socket ownership evidence", async () => {
    await expect(
      checkSetupSocketEvidence({
        platform: "linux",
        access: fakeAccess(["/usr/bin/lsof"]),
      }),
    ).resolves.toEqual({ status: "ok", command: "/usr/bin/lsof" });

    await expect(
      checkSetupSocketEvidence({ platform: "darwin", access: fakeAccess([]) }),
    ).resolves.toEqual({ status: "missing", command: "/usr/sbin/lsof" });
  });

  it("executes the compiled asset probe from the state directory", async () => {
    const root = await tempRoot(tempRoots);
    const path = join(root, "state");

    await expect(
      checkSetupStateDir({ path, executable: true, probeName: ".probe" }),
    ).resolves.toEqual({ status: "ok", path });
    await expect(access(join(path, ".probe"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects and cleans up a compiled state directory that cannot execute assets", async () => {
    const root = await tempRoot(tempRoots);
    const path = join(root, "state");

    await expect(
      checkSetupStateDir({
        path,
        executable: true,
        probeName: ".probe",
        execute: async () => {
          throw Object.assign(new Error("execution denied"), { code: "EACCES" });
        },
      }),
    ).resolves.toEqual({
      status: "missing",
      path,
      message: `STATION state directory does not permit executable assets at ${path}.`,
    });
    await expect(access(join(path, ".probe"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an actionable state-directory failure and cleans up the probe", async () => {
    const unlinked: string[] = [];
    const path = "/readonly/state";

    await expect(
      checkSetupStateDir({
        path,
        probeName: ".probe",
        fs: {
          async mkdir() {},
          async open() {
            throw Object.assign(new Error("read only"), { code: "EACCES" });
          },
          async unlink(probePath) {
            unlinked.push(probePath);
          },
        },
      }),
    ).resolves.toEqual({
      status: "missing",
      path,
      message: `STATION state directory is not writable at ${path}.`,
    });
    expect(unlinked).toEqual([join(path, ".probe")]);
  });

  it("skips source renderer and Xcode probes in compiled setup", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const stationUiInstalled = vi.fn(async () => false);

    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      compiled: true,
      platform: "darwin",
      env: { PATH: "/fake/bin" },
      runner: fakeRunner(calls, {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      }),
      access: fakeAccess([]),
      fs: readOnlyFs({}),
      stationUiInstalled,
    });
    const plan = buildSetupPlan(facts);

    expect(stationUiInstalled).not.toHaveBeenCalled();
    expect(calls.some((call) => call.command === "xcode-select")).toBe(false);
    expect(plan.summary.launchReady).toBe(true);
    expect(plan.checks.some((check) => check.id === "bun")).toBe(false);
    expect(plan.checks.some((check) => check.id === "station-ui")).toBe(false);
    expect(plan.checks.some((check) => check.id === "command-line-tools")).toBe(false);
  });

  it("uses the fast compiled binding for default geometry without losing explicit config identity", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const home = join(root, "home");
    const defaultConfigPath = join(home, ".config/station/config.toml");
    const explicitConfigPath = join(root, "explicit-default.toml");
    const invalidConfigPath = join(root, "invalid.toml");
    const missingConfigPath = join(root, "missing.toml");
    const installedRoot = join(root, "installed");
    const popupAlias = join(installedRoot, "stn-tmux-popup");
    await mkdir(repo, { recursive: true });

    const baseOptions = {
      mode: "check" as const,
      cwd: repo,
      compiled: true,
      tmuxPopupOwnerRoot: installedRoot,
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
        "/fake/bin/stn",
        "/fake/bin/stn-ingress",
        popupAlias,
      ]),
      fs: readOnlyFs({
        [defaultConfigPath]: configToml(repo, {
          popupWidth: "50%",
          popupHeight: "50%",
          popupPosition: "C",
        }),
        [explicitConfigPath]: configToml(repo, {
          popupWidth: "50%",
          popupHeight: "50%",
          popupPosition: "C",
        }),
        [invalidConfigPath]: 'schema_version = "invalid"\n',
      }),
    };
    const facts = await collectSetupFacts({ ...baseOptions, homeDir: home });
    const explicit = await collectSetupFacts({
      ...baseOptions,
      configPath: explicitConfigPath,
      homeDir: home,
    });
    const explicitMissing = await collectSetupFacts({
      ...baseOptions,
      configPath: missingConfigPath,
      homeDir: home,
    });
    const invalid = await collectSetupFacts({
      ...baseOptions,
      configPath: invalidConfigPath,
      homeDir: home,
    });
    const implicitMissing = await collectSetupFacts({
      ...baseOptions,
      homeDir: join(root, "empty-home"),
    });

    expect(facts.launchers.tmuxPopup).toMatchObject({
      status: "ok",
      source: "installed",
      resolvedPath: popupAlias,
    });
    expect(facts.tmuxBinding).toMatchObject({
      status: "missing",
      launcherCommand: popupAlias,
      bindingKey: "Space",
    });
    expect(facts.tmuxBinding.runShellCommand).toBe(
      buildManagedFastPopupRunShellCommand({
        configPath: defaultConfigPath,
        installedRoot,
        fallbackAlias: popupAlias,
        tmuxCommand: "/fake/bin/tmux",
      }),
    );
    expect(explicit.tmuxBinding.runShellCommand).toBe(
      tmuxPopupRunShellCommand(popupAlias, explicitConfigPath),
    );
    expect(explicitMissing.config.status).toBe("missing");
    expect(explicitMissing.tmuxBinding.runShellCommand).toBe(
      tmuxPopupRunShellCommand(popupAlias, missingConfigPath),
    );
    expect(invalid.config.status).toBe("invalid");
    expect(invalid.tmuxBinding.runShellCommand).toBe(
      tmuxPopupRunShellCommand(popupAlias, invalidConfigPath),
    );
    expect(implicitMissing.config.status).toBe("missing");
    expect(implicitMissing.tmuxBinding.runShellCommand).toBe(
      buildManagedFastPopupRunShellCommand({
        installedRoot,
        fallbackAlias: popupAlias,
        tmuxCommand: "/fake/bin/tmux",
      }),
    );
    expect(buildSetupPlan(facts).actions.some((action) => action.id === "tmux-popup-binding")).toBe(
      true,
    );
  });

  it("uses the config-aware popup alias for compiled bindings with custom geometry", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const home = join(root, "home");
    const configPath = join(root, "custom-config.toml");
    const installedRoot = join(root, "installed");
    const popupAlias = join(installedRoot, "stn-tmux-popup");
    await mkdir(repo, { recursive: true });

    const facts = await collectSetupFacts({
      mode: "check",
      configPath,
      cwd: repo,
      homeDir: home,
      compiled: true,
      tmuxPopupOwnerRoot: installedRoot,
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
        "/fake/bin/stn",
        "/fake/bin/stn-ingress",
        popupAlias,
      ]),
      fs: readOnlyFs({
        [configPath]: configToml(repo, {
          popupWidth: "80",
          popupHeight: "24",
          popupPosition: "C",
        }),
      }),
    });

    expect(facts.tmuxBinding.runShellCommand).toBe(
      tmuxPopupRunShellCommand(popupAlias, configPath),
    );
    expect(facts.tmuxBinding.runShellCommand).toContain("STATION_CONFIG_PATH=");
    expect(facts.tmuxBinding.runShellCommand).not.toContain("station-popup-binding");
  });

  it("reports missing tmux without trying to generate a compiled fast binding", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const installedRoot = join(root, "installed");
    const popupAlias = join(installedRoot, "stn-tmux-popup");
    await mkdir(repo, { recursive: true });

    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      compiled: true,
      tmuxPopupOwnerRoot: installedRoot,
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      }),
      access: fakeAccess([popupAlias]),
      fs: readOnlyFs({}),
    });

    expect(facts.tmux.status).toBe("missing");
    expect(facts.tmuxBinding.runShellCommand).toBe(tmuxPopupRunShellCommand(popupAlias));
    expect(buildSetupPlan(facts).actions.some((action) => action.id === "tmux-popup-binding")).toBe(
      false,
    );
  });

  it("collects core facts through injected effects only", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const runner = fakeRunner(calls, {
      "git rev-parse --show-toplevel": repo,
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      "wt --version": "worktrunk 1.2.3\n",
      "tmux -V": "tmux 3.5a\n",
      "brew --version": "Homebrew 4.0.0\n",
      "codex --version": "codex 0.1.0\n",
    });
    const fs = readOnlyFs({
      [join(root, "home/.config/station/config.toml")]: configToml(repo),
    });

    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner,
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs,
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      stationUiInstalled: async () => false,
    });

    expect(facts.worktrunk).toMatchObject({ status: "ok", command: "wt", version: "1.2.3" });
    expect(facts.tmux).toMatchObject({ status: "ok", command: "tmux", version: "3.5a" });
    expect(facts.git).toMatchObject({ status: "ok", root: repo, defaultBranch: "main" });
    expect(facts.config).toMatchObject({ status: "valid", hasProjectForRoot: true });
    expect(facts.harnesses.find((harness) => harness.id === "codex")).toMatchObject({
      status: "ok",
      command: "codex",
    });
    expect(calls.map((call) => `${call.command} ${(call.args ?? []).join(" ")}`)).not.toContain(
      "gh --version",
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "/fake/bin/wt", timeoutMs: setupProbeTimeoutMs }),
        expect.objectContaining({ command: "/fake/bin/tmux", timeoutMs: setupProbeTimeoutMs }),
        expect.objectContaining({ command: "git", timeoutMs: setupProbeTimeoutMs }),
        expect.objectContaining({ command: "brew", timeoutMs: setupProbeTimeoutMs }),
        expect.objectContaining({ command: "codex", timeoutMs: setupProbeTimeoutMs }),
      ]),
    );
  });

  it("marks missing Worktrunk and tmux as required failures", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner(calls, {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([]),
      fs: readOnlyFs({}),
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      stationUiInstalled: async () => false,
    });
    const plan = buildSetupPlan(facts);

    expect(plan.summary.requiredOk).toBe(false);
    expect(
      plan.checks.filter((check) => check.status === "missing").map((check) => check.id),
    ).toEqual(["worktrunk", "tmux", "bun", "config", "diffnav", "git-delta"]);
  });

  it("warns in setup check when Bun works but the station UI lane is not installed", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const base = {
      mode: "check" as const,
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      }),
      access: fakeAccess(["/fake/bin/bun"]),
      fs: readOnlyFs({}),
    };

    const missing = buildSetupPlan(
      await collectSetupFacts({ ...base, stationUiInstalled: async () => false }),
    );
    expect(missing.checks.find((check) => check.id === "station-ui")).toMatchObject({
      tier: "recommended",
      status: "warning",
    });

    const installed = buildSetupPlan(
      await collectSetupFacts({ ...base, stationUiInstalled: async () => true }),
    );
    expect(installed.checks.find((check) => check.id === "station-ui")).toMatchObject({
      tier: "recommended",
      status: "ok",
    });
  });

  it("selects the first available harness from detection order", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const facts = await collectSetupFacts({
      mode: "plan",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner(calls, {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "brew --version": "Homebrew 4.0.0\n",
        "agent --version": "cursor-agent 1.0.0\n",
        "opencode --version": "opencode 1.0.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({}),
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      stationUiInstalled: async () => false,
    });
    const plan = buildSetupPlan(facts);

    expect(plan.summary.selectedHarness).toBe("cursor");
  });

  it("ignores Crush when choosing a supported harness", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = await collectSetupFacts({
      mode: "plan",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "brew --version": "Homebrew 4.0.0\n",
        "crush --version": "crush version 1.2.3\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({}),
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      stationUiInstalled: async () => false,
    });
    const plan = buildSetupPlan(facts);

    expect(facts.harnesses.some((harness) => harness.id === "crush")).toBe(false);
    expect(plan.summary.selectedHarness).toBeUndefined();
    expect(plan.checks.find((check) => check.id === "harness")).toMatchObject({
      status: "missing",
      message: "Install one supported harness CLI: claude, codex, cursor agent, opencode, or pi.",
    });
  });

  it("detects harness CLIs installed under the user local bin directory", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const home = join(root, "home");
    await mkdir(repo, { recursive: true });
    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: home,
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        [`${home}/.local/bin/agent --version`]: "cursor-agent 1.0.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({}),
      noBrew: true,
    });

    expect(facts.harnesses.find((harness) => harness.id === "cursor")).toMatchObject({
      status: "ok",
      command: `${home}/.local/bin/agent`,
    });
  });

  it("derives Worktrunk automation mode from existing config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "wt switch --help": "Usage: wt switch --no-hooks --yes\n",
        "wt remove --help": "Usage: wt remove --no-hooks --yes\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({
        [join(root, "home/.config/station/config.toml")]: configToml(repo, {
          useLifecycleHooks: false,
        }),
      }),
      noBrew: true,
    });
    const plan = buildSetupPlan(facts);

    expect(facts.config).toMatchObject({
      status: "valid",
      worktrunkUseLifecycleHooks: false,
    });
    expect(plan.checks.find((check) => check.id === "worktrunk-hooks")).toMatchObject({
      status: "ok",
      message: expect.stringContaining("--no-hooks"),
      details: {
        automationMode: "skip-hooks",
      },
    });
  });

  it("derives Worktrunk hook pre-approval mode from existing config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "wt switch --help": "Usage: wt switch --no-hooks --yes\n",
        "wt remove --help": "Usage: wt remove --no-hooks --yes\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({
        [join(root, "home/.config/station/config.toml")]: configToml(repo, {
          useLifecycleHooks: true,
        }),
      }),
      noBrew: true,
    });
    const plan = buildSetupPlan(facts);

    expect(plan.checks.find((check) => check.id === "worktrunk-hooks")).toMatchObject({
      status: "ok",
      message: expect.stringContaining("--yes"),
      details: {
        automationMode: "preapprove-hooks",
      },
    });
  });

  it("does not report Worktrunk automation ready when required flags are unsupported", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "wt switch --help": "Usage: wt switch\n",
        "wt remove --help": "Usage: wt remove --yes\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({
        [join(root, "home/.config/station/config.toml")]: configToml(repo, {
          useLifecycleHooks: false,
        }),
      }),
      noBrew: true,
    });
    const plan = buildSetupPlan(facts);

    expect(plan.checks.find((check) => check.id === "worktrunk-hooks")).toMatchObject({
      status: "warning",
      message: expect.stringContaining("--no-hooks"),
      details: {
        automationMode: "skip-hooks",
        flag: "--no-hooks",
        missingSubcommands: "switch, remove",
      },
    });
  });

  it("falls back to current branch and then main for git default branch", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner(calls, {
        "git rev-parse --show-toplevel": repo,
        "git rev-parse --abbrev-ref HEAD": "feature/setup\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({}),
      noBrew: true,
    });

    expect(facts.git).toMatchObject({ status: "ok", defaultBranch: "feature/setup" });
  });

  it("treats invalid config as a required setup failure", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({
        [join(root, "home/.config/station/config.toml")]: "schema_version = 1\n[defaults\n",
      }),
      noBrew: true,
    });
    const plan = buildSetupPlan(facts);

    expect(plan.summary.requiredOk).toBe(false);
    expect(plan.checks.find((check) => check.id === "config")).toMatchObject({
      status: "missing",
    });
  });

  it("surfaces best-effort config diagnostics without failing required setup", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({
        [join(root, "home/.config/station/config.toml")]: `${configToml(repo)}
[workspace]
scroll_on_output = "teleport"
`,
      }),
      noBrew: true,
    });
    const plan = buildSetupPlan(facts);

    expect(facts.config).toMatchObject({
      status: "valid",
      diagnostics: [expect.objectContaining({ severity: "warn" })],
    });
    if (facts.config.status !== "valid") {
      throw new Error("expected setup config to load with diagnostics");
    }
    const [diagnostic] = facts.config.diagnostics ?? [];
    if (diagnostic === undefined) {
      throw new Error("expected setup config diagnostics");
    }
    expect(plan.summary.requiredOk).toBe(true);
    expect(plan.summary.requiredMissing).toBe(0);
    expect(plan.checks.find((check) => check.id === "config")).toMatchObject({
      tier: "required",
      status: "ok",
    });
    expect(plan.checks.find((check) => check.id === "config-diagnostics")).toMatchObject({
      tier: "recommended",
      status: "warning",
      message: expect.stringContaining(diagnostic.message),
    });
    expect(plan.nextSteps).toEqual(["stn doctor", "stn"]);
  });

  it("fails readiness for existing config defaults outside the setup core path", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const otherRepo = join(root, "other");
    await mkdir(repo, { recursive: true });
    await mkdir(otherRepo, { recursive: true });
    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({
        [join(root, "home/.config/station/config.toml")]: configToml(otherRepo, {
          worktreeProvider: "noop-worktree",
        }),
      }),
      noBrew: true,
    });
    const plan = buildSetupPlan(facts);

    expect(plan.summary.requiredOk).toBe(false);
    expect(plan.checks.find((check) => check.id === "config")?.message).toContain("noop-worktree");
  });

  it("fails readiness when an existing project uses an unsupported harness", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const facts = await collectSetupFacts({
      mode: "check",
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
      }),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/diffnav",
        "/fake/bin/delta",
      ]),
      fs: readOnlyFs({
        [join(root, "home/.config/station/config.toml")]: configToml(repo, {
          harness: "missing-harness",
        }),
      }),
      noBrew: true,
    });
    const plan = buildSetupPlan(facts);

    expect(plan.summary.requiredOk).toBe(false);
    expect(plan.checks.find((check) => check.id === "config")?.message).toContain(
      "missing-harness",
    );
  });

  it("generates a tmux popup binding with tmux-format quoting for client names", () => {
    const binding = tmuxPopupBindingBlock();
    const clientNames = ["client one", "client'quote", "client;rm -rf", "client$(touch nope)"];

    expect(binding).toContain("STATION_FOCUS_CLIENT_ID=#{q:client_name}");
    expect(binding).not.toContain('STATION_FOCUS_CLIENT_ID="#{client_name}"');
    for (const clientName of clientNames) {
      expect(binding).not.toContain(clientName);
    }
  });

  it("carries an explicit config through the popup alias environment and arguments", () => {
    const command = tmuxPopupRunShellCommand(
      "/opt/station/stn-tmux-popup",
      "/tmp/station-#{session_name}/config.toml",
    );

    expect(command).toContain("STATION_CONFIG_PATH='/tmp/station-##{session_name}/config.toml'");
    expect(command).toContain("--config '/tmp/station-##{session_name}/config.toml'");
  });

  it.each([
    "\0",
    "\r",
    "\n",
  ])("rejects %j in managed popup launcher and config values", (control) => {
    expect(() => tmuxPopupRunShellCommand(`/opt/station/stn${control}-tmux-popup`)).toThrow(
      "unsupported control character",
    );
    expect(() =>
      tmuxPopupRunShellCommand("/opt/station/stn-tmux-popup", `/tmp/station${control}/config.toml`),
    ).toThrow("unsupported control character");
  });

  it("persists an exact generated command and defaults a fresh block to Space", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/opt/station/stn-tmux-popup";
    const runShellCommand = "managed-fast-command --exact '#{q:client_name}'";

    const missing = await checkSetupTmuxBinding({
      homeDir,
      launcherCommand,
      runShellCommand,
      fs: readOnlyFs({}),
    });

    expect(missing).toMatchObject({
      status: "missing",
      bindingKey: "Space",
      launcherCommand,
      runShellCommand,
    });
    const quotedCommand = `'${runShellCommand.replaceAll("'", "'\\''")}'`;
    expect(tmuxPopupBindingBlock(launcherCommand, { runShellCommand })).toContain(
      `bind-key Space run-shell -b ${quotedCommand}`,
    );
  });

  it("marks a binding stale when an explicit config path is added", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const installedRoot = "/opt/station";
    const launcherCommand = `${installedRoot}/stn-tmux-popup`;
    const base = {
      fallbackAlias: launcherCommand,
      installedRoot,
      tmuxCommand: "/opt/homebrew/bin/tmux",
    };
    const previous = buildManagedFastPopupRunShellCommand(base);
    const current = tmuxPopupRunShellCommand(launcherCommand, "/tmp/station/config.toml");

    await expect(
      checkSetupTmuxBinding({
        homeDir,
        launcherCommand,
        runShellCommand: current,
        fs: readOnlyFs({
          [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand, {
            bindingKey: "M-p",
            runShellCommand: previous,
          }),
        }),
      }),
    ).resolves.toMatchObject({
      status: "missing",
      bindingKey: "M-p",
      message: expect.stringContaining("stale"),
    });
  });

  it("round-trips the physical one-line compiled command through the owned block", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const installedRoot = "/opt/station/bin";
    const launcherCommand = `${installedRoot}/stn-tmux-popup`;
    const runShellCommand = buildManagedFastPopupRunShellCommand({
      installedRoot,
      fallbackAlias: launcherCommand,
      tmuxCommand: "/usr/bin/tmux",
    });

    expect(runShellCommand).not.toMatch(/[\r\n]/);
    await expect(
      checkSetupTmuxBinding({
        homeDir,
        launcherCommand,
        runShellCommand,
        fs: readOnlyFs({
          [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand, {
            runShellCommand,
          }),
        }),
      }),
    ).resolves.toMatchObject({
      status: "ok",
      bindingKey: "Space",
      runShellCommand,
    });
  });

  it.each([
    "p",
    "Space",
    "F12",
    "C-Space",
    "M-p",
    "C-s",
  ])("preserves the supported customized key %s while upgrading Station's command", async (bindingKey) => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/opt/station/stn-tmux-popup";
    const runShellCommand = "managed-fast-command";

    const binding = await checkSetupTmuxBinding({
      homeDir,
      launcherCommand,
      runShellCommand,
      fs: readOnlyFs({
        [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock("old-popup", {
          bindingKey,
        }),
      }),
    });

    expect(binding).toMatchObject({
      status: "missing",
      bindingKey,
      runShellCommand,
      message: expect.stringContaining(`preserving ${bindingKey}`),
    });
  });

  it("accepts an explicit prefix table and matches the preserved live key exactly", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/opt/station/stn-tmux-popup";
    const runShellCommand = "managed-fast-command";
    const quotedCommand = `'${runShellCommand}'`;
    const serialized = runShellCommand.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

    const binding = await checkSetupTmuxBinding({
      homeDir,
      env: { TMUX: "/tmp/tmux.sock,1,0" },
      launcherCommand,
      runShellCommand,
      runner: async (input) => ({
        command: input.command,
        args: input.args ?? [],
        stdout:
          input.args?.[0] === "list-keys"
            ? `bind-key -T prefix C-Space run-shell -b "${serialized}"\n`
            : "",
        stderr: "",
        exitCode: 0,
      }),
      fs: readOnlyFs({
        [join(homeDir, ".tmux.conf")]: [
          "# >>> station popup binding >>>",
          `bind-key -T prefix C-Space run-shell -b ${quotedCommand}`,
          "# <<< station popup binding <<<",
          "",
        ].join("\n"),
      }),
    });

    expect(binding).toMatchObject({ status: "ok", bindingKey: "C-Space", liveStatus: "loaded" });
  });

  it("treats deleted, commented, and unmarked bindings as absent without inferring a key", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const markedComment = [
      "# >>> station popup binding >>>",
      "# bind-key C-s run-shell -b 'old-popup'",
      "# <<< station popup binding <<<",
      "",
    ].join("\n");
    const unmarked = "bind-key M-p run-shell -b 'stn-tmux-popup'\n";

    for (const source of [markedComment, unmarked]) {
      await expect(
        checkSetupTmuxBinding({
          homeDir,
          runShellCommand: "managed-fast-command",
          fs: readOnlyFs({ [join(homeDir, ".tmux.conf")]: source }),
        }),
      ).resolves.toMatchObject({ status: "missing", bindingKey: "Space" });
    }
  });

  it.each([
    {
      name: "duplicate markers",
      source: `${tmuxPopupBindingBlock()}${tmuxPopupBindingBlock()}`,
    },
    {
      name: "a malformed marker",
      source: [
        "# >>> station popup binding >>> trailing",
        "bind-key Space run-shell -b 'stn-tmux-popup'",
        "# <<< station popup binding <<<",
      ].join("\n"),
    },
    {
      name: "multiple active lines",
      source: [
        "# >>> station popup binding >>>",
        "bind-key Space run-shell -b 'stn-tmux-popup'",
        "bind-key p run-shell -b 'stn-tmux-popup'",
        "# <<< station popup binding <<<",
      ].join("\n"),
    },
    {
      name: "multiple commands on one active line",
      source: [
        "# >>> station popup binding >>>",
        "bind-key C-s run-shell -b 'old-popup' ; bind-key M-p display-message hi",
        "# <<< station popup binding <<<",
      ].join("\n"),
    },
    {
      name: "a non-prefix selector",
      source: [
        "# >>> station popup binding >>>",
        "bind-key -T root p run-shell -b 'stn-tmux-popup'",
        "# <<< station popup binding <<<",
      ].join("\n"),
    },
    {
      name: "an unsupported key",
      source: [
        "# >>> station popup binding >>>",
        "bind-key MouseDown1 run-shell -b 'stn-tmux-popup'",
        "# <<< station popup binding <<<",
      ].join("\n"),
    },
  ])("reports $name as a conflict without probing live tmux", async ({ source }) => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const runner = vi.fn<ExternalCommandRunner>();

    const binding = await checkSetupTmuxBinding({
      homeDir,
      env: { TMUX: "/tmp/tmux.sock,1,0" },
      runner,
      fs: readOnlyFs({ [join(homeDir, ".tmux.conf")]: source }),
    });

    expect(binding).toMatchObject({ status: "conflict", liveStatus: "unknown" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("escapes tmux formats in absolute launcher paths", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/tmp/station-#{session_name}/stn-tmux-popup";
    const runShellCommand = tmuxPopupRunShellCommand(launcherCommand);
    const serialized = runShellCommand.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const calls: ExternalCommandInput[] = [];

    expect(runShellCommand).toBe(
      "env STATION_FOCUS_PROVIDER=tmux STATION_FOCUS_CLIENT_ID=#{q:client_name} '/tmp/station-##{session_name}/stn-tmux-popup'",
    );
    expect(tmuxPopupBindingBlock(launcherCommand)).toContain(
      "STATION_FOCUS_CLIENT_ID=#{q:client_name}",
    );

    await checkSetupTmuxBinding({
      homeDir,
      env: { TMUX: "/tmp/tmux.sock,1,0" },
      launcherCommand,
      runner: async (input) => {
        calls.push(input);
        return {
          command: input.command,
          args: input.args ?? [],
          stdout:
            input.args?.[0] === "list-keys"
              ? `bind-key -T prefix Space run-shell -b "${serialized}"\n`
              : "",
          stderr: "",
          exitCode: 0,
        };
      },
      fs: readOnlyFs({
        [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand),
      }),
    });

    expect(calls.at(1)?.args).toEqual([
      "run-shell",
      "env STATION_SETUP_LAUNCHER_PROBE=1 '/tmp/station-##{session_name}/stn-tmux-popup' --help >/dev/null 2>&1",
    ]);
  });

  it("requires executable launchers and resolves PATH entries to absolute paths", async () => {
    const root = await tempRoot(tempRoots);
    const binDir = join(root, "launcher bin");
    await mkdir(binDir, { recursive: true });
    await Promise.all(
      ["stn", "stn-ingress", "stn-tmux-popup"].map((command) =>
        writeFile(join(binDir, command), "#!/bin/sh\n"),
      ),
    );
    await chmod(join(binDir, "stn"), 0o755);
    await chmod(join(binDir, "stn-ingress"), 0o644);
    await chmod(join(binDir, "stn-tmux-popup"), 0o755);

    const launchers = await checkSetupLaunchers({
      env: { PATH: binDir },
      packageRoot: join(root, "empty-checkout"),
    });

    expect(launchers.station).toMatchObject({
      status: "ok",
      source: "path",
      resolvedPath: join(binDir, "stn"),
    });
    expect(launchers.ingress).toMatchObject({ status: "missing" });
    expect(launchers.tmuxPopup).toMatchObject({
      status: "ok",
      source: "path",
      resolvedPath: join(binDir, "stn-tmux-popup"),
    });
  });

  it("rejects a split PATH when the active runtime ingress sibling is missing", async () => {
    const root = await tempRoot(tempRoots);
    const runtimeBin = join(root, "runtime");
    const shadowBin = join(root, "shadow");
    await Promise.all([
      mkdir(runtimeBin, { recursive: true }),
      mkdir(shadowBin, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(runtimeBin, "stn"), "#!/bin/sh\n"),
      writeFile(join(shadowBin, "stn-ingress"), "#!/bin/sh\n"),
    ]);
    await Promise.all([
      chmod(join(runtimeBin, "stn"), 0o755),
      chmod(join(shadowBin, "stn-ingress"), 0o755),
    ]);
    const runtimeIngress = join(runtimeBin, "stn-ingress");

    const launchers = await checkSetupLaunchers({
      env: { PATH: `${runtimeBin}${delimiter}${shadowBin}` },
      packageRoot: join(root, "empty-checkout"),
      providerHookIngressLauncher: runtimeIngress,
    });

    expect(launchers.station).toMatchObject({
      status: "ok",
      resolvedPath: join(runtimeBin, "stn"),
    });
    expect(launchers.ingress).toMatchObject({
      status: "missing",
      command: runtimeIngress,
      message: expect.stringContaining(runtimeIngress),
    });
    expect(launchers.ingress).not.toMatchObject({ resolvedPath: join(shadowBin, "stn-ingress") });
  });

  it("skips executable directories that shadow launcher names on PATH", async () => {
    const root = await tempRoot(tempRoots);
    const shadowDir = join(root, "shadow");
    const binDir = join(root, "bin");
    const commands = ["stn", "stn-ingress", "stn-tmux-popup"];
    await Promise.all(
      commands.map((command) => mkdir(join(shadowDir, command), { recursive: true })),
    );
    await mkdir(binDir, { recursive: true });
    await Promise.all(
      commands.map(async (command) => {
        const path = join(binDir, command);
        await writeFile(path, "#!/bin/sh\n");
        await chmod(path, 0o755);
      }),
    );

    const launchers = await checkSetupLaunchers({
      env: { PATH: `${shadowDir}${delimiter}${binDir}` },
      packageRoot: join(root, "empty-checkout"),
    });

    expect(launchers.station.resolvedPath).toBe(join(binDir, "stn"));
    expect(launchers.ingress.resolvedPath).toBe(join(binDir, "stn-ingress"));
    expect(launchers.tmuxPopup.resolvedPath).toBe(join(binDir, "stn-tmux-popup"));
  });

  it("recognizes an exact absolute tmux binding with quoted path characters", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/tmp/station install's/bin/stn-tmux-popup";

    await expect(
      checkSetupTmuxBinding({
        homeDir,
        launcherCommand,
        fs: readOnlyFs({
          [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand),
        }),
      }),
    ).resolves.toMatchObject({
      status: "ok",
      launcherCommand,
      liveStatus: "unknown",
    });
  });

  it("checks the exact live binding and launcher startup in the tmux server", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/tmp/station install's/bin/stn-tmux-popup";
    const runShellCommand = tmuxPopupRunShellCommand(launcherCommand);
    const serialized = runShellCommand.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const calls: ExternalCommandInput[] = [];
    const runner = async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
      calls.push(input);
      const listKeys = input.args?.[0] === "list-keys";
      return {
        command: input.command,
        args: input.args ?? [],
        stdout: listKeys ? `bind-key    -T prefix Space   run-shell -b "${serialized}"\n` : "",
        stderr: "",
        exitCode: 0,
      };
    };

    await expect(
      checkSetupTmuxBinding({
        homeDir,
        env: { TMUX: "/tmp/tmux.sock,1,0" },
        launcherCommand,
        runner,
        fs: readOnlyFs({
          [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand),
        }),
      }),
    ).resolves.toMatchObject({ status: "ok", liveStatus: "loaded" });
    expect(calls).toEqual([
      expect.objectContaining({ args: ["list-keys", "-T", "prefix"] }),
      expect.objectContaining({
        args: [
          "run-shell",
          "env STATION_SETUP_LAUNCHER_PROBE=1 '/tmp/station install'\\''s/bin/stn-tmux-popup' --help >/dev/null 2>&1",
        ],
      }),
    ]);
  });

  it("decodes tmux's context-sensitive command serialization for a customized key", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/tmp/bin/stn-tmux-popup";
    const runShellCommand = 'encoded_script=$1; probe="$quoted"; result="$(subshell)"';
    const listedBinding = String.raw`bind-key    -T prefix C-s     run-shell -b "encoded_script=$1; probe=\"\$quoted\"; result=\"$(subshell)\""`;

    const binding = await checkSetupTmuxBinding({
      homeDir,
      env: { TMUX: "/tmp/tmux.sock,1,0" },
      launcherCommand,
      runShellCommand,
      runner: async (input) => ({
        command: input.command,
        args: input.args ?? [],
        stdout: input.args?.[0] === "list-keys" ? `${listedBinding}\n` : "",
        stderr: "",
        exitCode: 0,
      }),
      fs: readOnlyFs({
        [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand, {
          bindingKey: "C-s",
          runShellCommand,
        }),
      }),
    });

    expect(binding).toMatchObject({
      status: "ok",
      bindingKey: "C-s",
      liveStatus: "loaded",
    });
  });

  it("probes whether the live launcher can start instead of only checking its mode", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/tmp/bin/stn-tmux-popup";
    const runShellCommand = tmuxPopupRunShellCommand(launcherCommand);
    const serialized = runShellCommand.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const calls: ExternalCommandInput[] = [];

    const binding = await checkSetupTmuxBinding({
      homeDir,
      env: { TMUX: "/tmp/tmux.sock,1,0" },
      launcherCommand,
      runner: async (input) => {
        calls.push(input);
        const listKeys = input.args?.[0] === "list-keys";
        return {
          command: input.command,
          args: input.args ?? [],
          stdout: listKeys ? `bind-key -T prefix Space run-shell -b "${serialized}"\n` : "",
          stderr: "",
          exitCode: listKeys || input.args?.[1]?.startsWith("test -x ") === true ? 0 : 1,
        };
      },
      fs: readOnlyFs({
        [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand),
      }),
    });

    expect(binding).toMatchObject({ status: "ok", liveStatus: "missing" });
    expect(calls.at(1)?.args).toEqual([
      "run-shell",
      "env STATION_SETUP_LAUNCHER_PROBE=1 '/tmp/bin/stn-tmux-popup' --help >/dev/null 2>&1",
    ]);
  });

  it("recognizes tmux's serialized dollar escaping in launcher paths", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/tmp/station $checkout/bin/stn-tmux-popup";
    const runShellCommand = tmuxPopupRunShellCommand(launcherCommand);
    const serialized = runShellCommand
      .replaceAll("\\", "\\\\")
      .replaceAll("$", "\\$")
      .replaceAll('"', '\\"');

    const binding = await checkSetupTmuxBinding({
      homeDir,
      env: { TMUX: "/tmp/tmux.sock,1,0" },
      launcherCommand,
      runner: async (input) => ({
        command: input.command,
        args: input.args ?? [],
        stdout:
          input.args?.[0] === "list-keys"
            ? `bind-key -T prefix Space run-shell -b "${serialized}"\n`
            : "",
        stderr: "",
        exitCode: 0,
      }),
      fs: readOnlyFs({
        [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand),
      }),
    });

    expect(binding).toMatchObject({ status: "ok", liveStatus: "loaded" });
  });

  it("does not accept live bindings whose startup probe fails or exits 127", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/tmp/bin/stn-tmux-popup";
    const runShellCommand = tmuxPopupRunShellCommand(launcherCommand);
    const serialized = runShellCommand.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

    for (const exitCode of [1, 127]) {
      const binding = await checkSetupTmuxBinding({
        homeDir,
        env: { TMUX: "/tmp/tmux.sock,1,0" },
        launcherCommand,
        runner: async (input) => ({
          command: input.command,
          args: input.args ?? [],
          stdout:
            input.args?.[0] === "list-keys"
              ? `bind-key -T prefix Space run-shell -b "${serialized}"\n`
              : "",
          stderr: "",
          exitCode: input.args?.[0] === "run-shell" ? exitCode : 0,
        }),
        fs: readOnlyFs({
          [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand),
        }),
      });

      expect(binding).toMatchObject({
        status: "ok",
        liveStatus: "missing",
        launcherCommand,
      });
    }
  });

  it("treats a legacy live bare binding that would exit 127 as not loaded", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const launcherCommand = "/tmp/bin/stn-tmux-popup";
    const bareRunShellCommand = tmuxPopupRunShellCommand("stn-tmux-popup");
    const serialized = bareRunShellCommand.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const calls: ExternalCommandInput[] = [];

    const binding = await checkSetupTmuxBinding({
      homeDir,
      env: { TMUX: "/tmp/tmux.sock,1,0" },
      launcherCommand,
      runner: async (input) => {
        calls.push(input);
        return {
          command: input.command,
          args: input.args ?? [],
          stdout: `bind-key -T prefix Space run-shell -b "${serialized}"\n`,
          stderr: "",
          exitCode: 0,
        };
      },
      fs: readOnlyFs({
        [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(launcherCommand),
      }),
    });

    expect(binding).toMatchObject({ status: "ok", liveStatus: "missing" });
    expect(calls).toHaveLength(1);
  });

  it("reports an owned old popup command as stale for a checkout launcher", async () => {
    const root = await tempRoot(tempRoots);
    const homeDir = join(root, "home");
    const binding = await checkSetupTmuxBinding({
      homeDir,
      launcherCommand: "/tmp/station/integrations/terminal/tmux/bin/stn-popup",
      fs: readOnlyFs({
        [join(homeDir, ".tmux.conf")]: tmuxPopupBindingBlock(),
      }),
    });

    expect(binding).toMatchObject({
      status: "missing",
      bindingKey: "Space",
      message:
        "tmux popup binding command is stale; rerun stn setup to update it while preserving Space.",
    });
  });
});

describe("checkSetupDiffnav", () => {
  it("reports ok with the resolved path when diffnav is on PATH", async () => {
    const fact = await checkSetupDiffnav({
      env: { PATH: "/fake/bin" },
      access: fakeAccess(["/fake/bin/diffnav"]),
    });
    expect(fact).toMatchObject({
      status: "ok",
      command: "diffnav",
      resolvedPath: "/fake/bin/diffnav",
    });
  });

  it("reports missing with an install hint when diffnav is absent", async () => {
    const fact = await checkSetupDiffnav({
      env: { PATH: "/fake/bin" },
      access: fakeAccess([]),
    });
    expect(fact.status).toBe("missing");
    expect(fact.message).toContain("brew install diffnav");
  });

  it("probes the literal diffnav the automation runs, ignoring any binary override", async () => {
    const fact = await checkSetupDiffnav({
      env: { PATH: "/fake/bin", STATION_DIFFNAV_BIN: "mydiff" },
      access: fakeAccess(["/fake/bin/mydiff"]),
    });
    // The automation command hardcodes `diffnav`; an override the station can't
    // honor must not let the doctor report a green that fails at runtime.
    expect(fact.status).toBe("missing");
  });
});

describe("checkSetupBun", () => {
  it("reports ok with the resolved path when bun is on PATH", async () => {
    const fact = await checkSetupBun({
      env: { PATH: "/fake/bin" },
      access: fakeAccess(["/fake/bin/bun"]),
    });
    expect(fact).toMatchObject({
      status: "ok",
      command: "bun",
      resolvedPath: "/fake/bin/bun",
    });
  });

  it("reports missing with an install hint when bun is absent", async () => {
    const fact = await checkSetupBun({
      env: { PATH: "/fake/bin" },
      access: fakeAccess([]),
    });
    expect(fact.status).toBe("missing");
    expect(fact.message).toContain("brew install bun");
  });

  it("reports ok without Bun when STATION_DASHBOARD_COMMAND overrides the renderer", async () => {
    // Mirrors doctor's rendererRuntimeCheck: a custom dashboard command means bun is
    // not needed, so the required check must not block setup even with bun absent.
    const fact = await checkSetupBun({
      env: { PATH: "/fake/bin", STATION_DASHBOARD_COMMAND: "my-renderer --foo" },
      access: fakeAccess([]),
    });
    expect(fact).toMatchObject({ status: "ok", command: "bun" });
  });
});

describe("checkSetupGitDelta", () => {
  it("reports ok with the resolved path when delta is on PATH", async () => {
    const fact = await checkSetupGitDelta({
      env: { PATH: "/fake/bin" },
      access: fakeAccess(["/fake/bin/delta"]),
    });
    expect(fact).toMatchObject({
      status: "ok",
      command: "delta",
      resolvedPath: "/fake/bin/delta",
    });
  });

  it("reports missing with a delta install hint when delta is absent", async () => {
    const fact = await checkSetupGitDelta({
      env: { PATH: "/fake/bin" },
      access: fakeAccess([]),
    });
    expect(fact.status).toBe("missing");
    expect(fact.message).toContain("git-delta");
  });
});

describe("checkSetupXcode", () => {
  it("is not applicable off macOS and never blocks setup", async () => {
    const fact = await checkSetupXcode({ platform: "linux" });
    expect(fact).toEqual({ status: "ok", applicable: false });
  });

  it("reports ok when xcode-select resolves a developer directory on macOS", async () => {
    const fact = await checkSetupXcode({
      platform: "darwin",
      runner: fakeRunner([], { "xcode-select -p": "/Library/Developer/CommandLineTools\n" }),
    });
    expect(fact).toMatchObject({ status: "ok", applicable: true });
  });

  it("reports missing with the xcode-select --install hint when CLT are absent", async () => {
    const fact = await checkSetupXcode({
      platform: "darwin",
      // A bare Mac: xcode-select exits non-zero ("unable to get active developer directory").
      runner: async () => {
        throw Object.assign(new Error("unable to get active developer directory"), { code: 1 });
      },
    });
    expect(fact.status).toBe("missing");
    if (fact.status !== "missing") throw new Error("expected missing CLT");
    expect(fact.message).toContain("xcode-select --install");
  });
});

describe("checkSetupGit", () => {
  it("distinguishes a missing git binary from a missing repository", async () => {
    const absent = await checkSetupGit({
      env: { PATH: "/fake/bin" },
      cwd: tmpdir(),
      runner: fakeRunner([], {}),
    });
    expect(absent).toMatchObject({ status: "missing", reason: "git-absent" });
    if (absent.status !== "missing") throw new Error("expected missing git");
    expect(absent.message).toContain("xcode-select --install");

    const notARepo = await checkSetupGit({
      env: { PATH: "/fake/bin" },
      cwd: tmpdir(),
      // git resolves but rev-parse fails with a non-ENOENT exit code.
      runner: async () => {
        throw Object.assign(new Error("not a git repository"), { code: 128 });
      },
    });
    expect(notARepo).toMatchObject({ status: "missing", reason: "not-a-repo" });
  });

  it("gives the safe.directory remediation when git refuses for dubious ownership", async () => {
    const dubious = await checkSetupGit({
      env: { PATH: "/fake/bin" },
      cwd: "/tmp/owned-by-root",
      // git runs but exits 128 with a dubious-ownership message; the user IS inside
      // the repo, so the remediation must point at safe.directory, not "not a repo".
      runner: async () => {
        throw Object.assign(
          new Error("fatal: detected dubious ownership in repository at '/tmp/owned-by-root'"),
          {
            code: 128,
            stderr: "fatal: detected dubious ownership in repository at '/tmp/owned-by-root'",
          },
        );
      },
    });
    expect(dubious).toMatchObject({ status: "missing", reason: "not-a-repo" });
    if (dubious.status !== "missing") throw new Error("expected missing git");
    expect(dubious.message).toContain("safe.directory");
  });
});

async function tempRoot(tempRoots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-setup-checks-"));
  tempRoots.push(root);
  return root;
}

function fakeRunner(
  calls: ExternalCommandInput[],
  outputs: Record<string, string>,
): (input: ExternalCommandInput) => Promise<ExternalCommandResult> {
  return async (input) => {
    calls.push(input);
    const key = `${input.command} ${(input.args ?? []).join(" ")}`;
    // Synthetic machines have macOS Command Line Tools unless a test overrides it.
    const stdout = outputs[key] ?? fakeBinOutput(input, outputs) ?? defaultProbeOutput(key);
    if (stdout === undefined) {
      throw Object.assign(new Error(`missing fake command: ${key}`), { code: "ENOENT" });
    }
    return {
      command: input.command,
      args: input.args ?? [],
      stdout,
      stderr: "",
      exitCode: 0,
    };
  };
}

function fakeBinOutput(
  input: ExternalCommandInput,
  outputs: Record<string, string>,
): string | undefined {
  if (!input.command.startsWith("/fake/bin/")) {
    return undefined;
  }
  return outputs[`${basename(input.command)} ${(input.args ?? []).join(" ")}`];
}

function defaultProbeOutput(key: string): string | undefined {
  return key === "xcode-select -p" ? "/Library/Developer/CommandLineTools\n" : undefined;
}

function fakeAccess(paths: readonly string[]): (path: string) => Promise<void> {
  const available = new Set(paths);
  return async (path) => {
    if (!available.has(path)) {
      throw Object.assign(new Error(`missing path: ${path}`), { code: "ENOENT" });
    }
  };
}

function readOnlyFs(files: Record<string, string>) {
  return {
    async readFile(path: string) {
      const source = files[path];
      if (source === undefined) {
        throw Object.assign(new Error(`missing file: ${path}`), { code: "ENOENT" });
      }
      return source;
    },
  };
}

function configToml(
  repo: string,
  options: {
    worktreeProvider?: string;
    terminal?: string;
    harness?: string;
    useLifecycleHooks?: boolean;
    popupWidth?: string;
    popupHeight?: string;
    popupPosition?: string;
  } = {},
): string {
  const lines = [
    "schema_version = 1",
    "",
    "[observer]",
    'socket_path = "~/.local/state/station/observer.sock"',
    'state_dir = "~/.local/state/station"',
    "",
    "[defaults]",
    `worktree_provider = ${JSON.stringify(options.worktreeProvider ?? "worktrunk")}`,
    `terminal = ${JSON.stringify(options.terminal ?? "tmux")}`,
    `harness = ${JSON.stringify(options.harness ?? "codex")}`,
    'layout = "agent-shell"',
    "",
    "[[projects]]",
    'id = "repo"',
    'label = "repo"',
    `root = ${JSON.stringify(repo)}`,
    "",
  ];
  if (options.useLifecycleHooks !== undefined) {
    lines.push(
      "[worktree.worktrunk]",
      `use_lifecycle_hooks = ${options.useLifecycleHooks ? "true" : "false"}`,
      "",
    );
  }
  if (
    options.popupWidth !== undefined ||
    options.popupHeight !== undefined ||
    options.popupPosition !== undefined
  ) {
    lines.push("[terminal.tmux]");
    if (options.popupWidth !== undefined) {
      lines.push(`popup_width = ${JSON.stringify(options.popupWidth)}`);
    }
    if (options.popupHeight !== undefined) {
      lines.push(`popup_height = ${JSON.stringify(options.popupHeight)}`);
    }
    if (options.popupPosition !== undefined) {
      lines.push(`popup_position = ${JSON.stringify(options.popupPosition)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
