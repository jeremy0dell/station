import { applySetupPlan } from "./apply.js";
import { checkBrewDependency } from "./checks/brew.js";
import { checkSetupBun } from "./checks/bun.js";
import { checkSetupDiffnav } from "./checks/diffnav.js";
import { checkSetupGitDelta } from "./checks/gitDelta.js";
import { checkSetupTmux } from "./checks/tmux.js";
import { checkSetupToolchain, type ToolchainFact } from "./checks/toolchain.js";
import { checkSetupWorktrunk } from "./checks/worktrunk.js";
import { applyOptions, dependencyOptionsForCommand } from "./flowUtils.js";
import { write } from "./io.js";
import type { SetupAction, SetupPlan } from "./model.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "./types.js";

export async function runSetupSystemCommand(
  args: { check: boolean; yes: boolean; noBrew: boolean },
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
): Promise<SetupCommandResult> {
  const initial = await collectSystemFacts(args, options, deps);
  await write(deps, renderSystemStatus("stn setup system", initial));

  if (args.yes && initial.brew.status === "ok") {
    const actions: SetupAction[] = [];
    if (initial.worktrunk.status === "missing")
      actions.push(systemInstallAction("worktrunk", "worktrunk"));
    if (initial.tmux.status === "missing") actions.push(systemInstallAction("tmux", "tmux"));
    if (initial.bun.status === "missing") actions.push(systemInstallAction("bun", "bun"));
    if (initial.diffnav.status === "missing")
      actions.push(systemInstallAction("diffnav", "dlvhdr/formulae/diffnav"));
    if (initial.gitDelta.status === "missing")
      actions.push(systemInstallAction("git-delta", "git-delta"));
    const result = await applySetupPlan(
      systemPlan(actions),
      applyOptions(deps, { announceActions: true, showCommandOutput: true }),
    );
    if (result.failedAction !== undefined) {
      await write(deps, "Install failed. Run: stn setup system --check\n");
      return { code: 1 };
    }
  }

  if (!args.yes) {
    return { code: systemReady(initial) ? 0 : 1 };
  }

  const refreshed = await collectSystemFacts(args, options, deps);
  await write(deps, renderSystemStatus("stn setup system final", refreshed));
  return { code: systemReady(refreshed) ? 0 : 1 };
}

type SystemFacts = {
  worktrunk: Awaited<ReturnType<typeof checkSetupWorktrunk>>;
  tmux: Awaited<ReturnType<typeof checkSetupTmux>>;
  bun: Awaited<ReturnType<typeof checkSetupBun>>;
  diffnav: Awaited<ReturnType<typeof checkSetupDiffnav>>;
  gitDelta: Awaited<ReturnType<typeof checkSetupGitDelta>>;
  brew: Awaited<ReturnType<typeof checkBrewDependency>>;
  toolchain: Awaited<ReturnType<typeof checkSetupToolchain>>;
};

async function collectSystemFacts(
  args: { noBrew: boolean },
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
): Promise<SystemFacts> {
  const env = deps.env ?? options.env;
  const dependencyOptions = dependencyOptionsForCommand(deps, env);
  const [worktrunk, tmux, bun, diffnav, gitDelta, brew, toolchain] = await Promise.all([
    checkSetupWorktrunk(dependencyOptions),
    checkSetupTmux(dependencyOptions),
    checkSetupBun(dependencyOptions),
    checkSetupDiffnav(dependencyOptions),
    checkSetupGitDelta(dependencyOptions),
    checkBrewDependency({
      ...(deps.runner === undefined ? {} : { runner: deps.runner }),
      ...(env === undefined ? {} : { env }),
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      noBrew: args.noBrew,
    }),
    checkSetupToolchain({
      ...(deps.runner === undefined ? {} : { runner: deps.runner }),
      ...(env === undefined ? {} : { env }),
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
    }),
  ]);
  return { worktrunk, tmux, bun, diffnav, gitDelta, brew, toolchain };
}

function renderSystemStatus(title: string, facts: SystemFacts): string {
  const lines = [
    title,
    "",
    `  ${facts.worktrunk.status === "ok" ? "ok" : "missing"} Worktrunk / wt`,
    `  ${facts.tmux.status === "ok" ? "ok" : "missing"} tmux`,
    `  ${facts.bun.status === "ok" ? "ok" : "missing"} Bun`,
    `  ${facts.diffnav.status === "ok" ? "ok" : "missing"} diffnav`,
    `  ${facts.gitDelta.status === "ok" ? "ok" : "missing"} git-delta`,
    `  ${facts.brew.status === "ok" ? "ok" : facts.brew.status} Homebrew`,
    `  ${toolchainStatusLabel(facts.toolchain.node)} Node.js ${toolchainVersionLabel(facts.toolchain.node)}`,
    `  ${toolchainStatusLabel(facts.toolchain.pnpm)} pnpm ${toolchainVersionLabel(facts.toolchain.pnpm)}`,
    "",
  ];
  const toolchainHints = runtimeToolchainHints(facts.toolchain);
  if (toolchainHints.length > 0) {
    lines.push("Development runtime:", ...toolchainHints, "");
  }
  return lines.join("\n");
}

function systemReady(facts: SystemFacts): boolean {
  return (
    facts.worktrunk.status === "ok" &&
    facts.tmux.status === "ok" &&
    facts.bun.status === "ok" &&
    facts.diffnav.status === "ok" &&
    facts.gitDelta.status === "ok" &&
    facts.toolchain.node.status === "ok" &&
    facts.toolchain.pnpm.status === "ok"
  );
}

function systemInstallAction(label: string, formula: string): SetupAction {
  return {
    id: `install-${label}`,
    kind: "brew-install",
    tier: "required",
    selected: true,
    label: `Install ${label}`,
    message: `Install ${label} with Homebrew.`,
    command: ["brew", "install", formula],
    data: { formula },
  };
}

function systemPlan(actions: SetupAction[]): SetupPlan {
  return {
    generatedAt: new Date().toISOString(),
    mode: "apply",
    checks: [],
    actions,
    summary: {
      requiredOk: true,
      requiredMissing: 0,
      warnings: 0,
      selectedActions: actions.length,
      configPath: "",
    },
    nextSteps: [],
  };
}

function toolchainStatusLabel(fact: ToolchainFact): string {
  return fact.status === "ok" ? "ok" : fact.status;
}

function toolchainVersionLabel(fact: ToolchainFact): string {
  const actual = fact.actual ?? "not found";
  return `${actual} (expected ${fact.expected})`;
}

function runtimeToolchainHints(toolchain: { node: ToolchainFact; pnpm: ToolchainFact }): string[] {
  const hints: string[] = [];
  if (toolchain.node.status !== "ok") {
    hints.push(
      "  Use your Node version manager to install and select Node.js 24.x, for example:",
      "    fnm install 24 && fnm use 24",
      "    nvm install 24 && nvm use 24",
    );
  }
  if (toolchain.pnpm.status !== "ok") {
    hints.push(
      "  After Node.js 24 is active, enable the repo-pinned package manager with:",
      "    corepack enable",
      "    corepack prepare pnpm@11.0.0 --activate",
    );
  }
  if (hints.length > 0) {
    hints.push("  STATION setup does not change Node or pnpm automatically.");
  }
  return hints;
}
