import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { checkSetupBun } from "../../src/commands/setup/checks/bun.js";
import { setupProbeTimeoutMs } from "../../src/commands/setup/checks/constants.js";
import { checkSetupDiffnav } from "../../src/commands/setup/checks/diffnav.js";
import { checkSetupGit } from "../../src/commands/setup/checks/git.js";
import { checkSetupGitDelta } from "../../src/commands/setup/checks/gitDelta.js";
import { collectSetupFacts } from "../../src/commands/setup/checks/system.js";
import {
  checkSetupTmuxBinding,
  tmuxPopupBindingBlock,
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

  it("reports old tmux popup bindings as missing when setup resolved a checkout launcher", async () => {
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
      message: "tmux popup binding is installed but uses an outdated STATION launcher command.",
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
    expect(fact.message).toContain("diffnav");
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
      cwd: "/tmp/not-a-repo",
      runner: fakeRunner([], {}),
    });
    expect(absent).toMatchObject({ status: "missing", reason: "git-absent" });
    if (absent.status !== "missing") throw new Error("expected missing git");
    expect(absent.message).toContain("xcode-select --install");

    const notARepo = await checkSetupGit({
      env: { PATH: "/fake/bin" },
      cwd: "/tmp/not-a-repo",
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
  return lines.join("\n");
}
