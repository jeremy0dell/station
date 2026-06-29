import { basename } from "node:path";
import { stableName } from "@station/runtime";
import { selectSetupHarness } from "./harnessSelection.js";
import type {
  ConfigWritePlan,
  SetupConfigFact,
  SetupFacts,
  SetupGitFact,
  SetupHarnessFact,
} from "./model.js";

export type PlanSetupConfigWriteOptions = {
  selectedHarness?: SetupHarnessFact;
  installWorktrunkHooks?: boolean;
  installHarnessHooks?: boolean;
};

export async function planSetupConfigWrite(
  facts: SetupFacts,
  options: PlanSetupConfigWriteOptions = {},
): Promise<ConfigWritePlan> {
  const selectedHarness = resolveConfigWriteHarness(
    facts,
    options.selectedHarness ?? selectSetupHarness(facts.harnesses, facts.selectedHarness),
  );
  if (selectedHarness === undefined) {
    return {
      operation: "blocked",
      path: facts.configPath,
      reason: "No supported harness CLI is available; config was not planned.",
    };
  }
  if (facts.git.status !== "ok") {
    return {
      operation: "blocked",
      path: facts.configPath,
      reason: "No git repository was detected; config was not planned.",
    };
  }

  if (facts.config.status === "missing") {
    return {
      operation: "create",
      path: facts.configPath,
      content: renderNewSetupConfig(facts.git, selectedHarness, facts, options),
    };
  }

  if (facts.config.status === "invalid") {
    return {
      operation: "blocked",
      path: facts.config.path,
      reason: facts.config.message,
    };
  }

  return planExistingConfigAppend(facts.config, facts.git, selectedHarness, options);
}

export function renderNewSetupConfig(
  git: Extract<SetupGitFact, { status: "ok" }>,
  harness: SetupHarnessFact,
  facts?: Pick<SetupFacts, "worktrunk" | "tmux">,
  options: Pick<PlanSetupConfigWriteOptions, "installWorktrunkHooks" | "installHarnessHooks"> = {},
): string {
  const projectId = projectIdForGit(git);
  const defaultBranch = git.defaultBranch;
  const worktrunkCommand =
    facts?.worktrunk === undefined ? "wt" : detectedCommand(facts.worktrunk, "wt");
  const tmuxCommand =
    facts?.tmux === undefined ? undefined : detectedOptionalCommand(facts.tmux, "tmux");
  const installWorktrunkHooks = options.installWorktrunkHooks === true;
  return [
    "schema_version = 1",
    "",
    "[observer]",
    'socket_path = "~/.local/state/station/observer.sock"',
    'state_dir = "~/.local/state/station"',
    "",
    "[defaults]",
    'worktree_provider = "worktrunk"',
    'terminal = "tmux"',
    `harness = ${tomlString(harness.id)}`,
    'layout = "agent-shell"',
    `default_branch = ${tomlString(defaultBranch)}`,
    "",
    "[worktree.worktrunk]",
    `command = ${tomlString(worktrunkCommand)}`,
    'managed_root = "~/.worktrees"',
    `base = ${tomlString(defaultBranch)}`,
    "include_main = false",
    "include_external = false",
    `use_lifecycle_hooks = ${installWorktrunkHooks ? "true" : "false"}`,
    `hook_mode = ${tomlString(installWorktrunkHooks ? "required-for-mvp" : "disabled")}`,
    "",
    "[terminal.tmux]",
    ...(tmuxCommand === undefined ? [] : [`command = ${tomlString(tmuxCommand)}`]),
    'session_prefix = "station"',
    'topology = "workbench"',
    'workbench_session = "station"',
    'window_naming = "project-branch"',
    "primary_agent_pane = true",
    "",
    `[harness.${harness.id}]`,
    "enabled = true",
    `command = ${tomlString(harness.command)}`,
    ...(options.installHarnessHooks === true && harnessSupportsHooks(harness.id)
      ? ["install_hooks = true"]
      : []),
    "",
    "[[projects]]",
    `id = ${tomlString(projectId)}`,
    `label = ${tomlString(git.repoName)}`,
    `root = ${tomlString(git.root)}`,
    "",
  ].join("\n");
}

function resolveConfigWriteHarness(
  facts: SetupFacts,
  fallback: SetupHarnessFact | undefined,
): SetupHarnessFact | undefined {
  if (facts.config.status !== "valid") {
    return fallback;
  }
  const configuredHarness = facts.config.matchedProject?.harness ?? facts.config.defaults.harness;
  return (
    facts.harnesses.find(
      (harness) => harness.id === configuredHarness && harness.status === "ok",
    ) ?? fallback
  );
}

function planExistingConfigAppend(
  config: Extract<SetupConfigFact, { status: "valid" }>,
  git: Extract<SetupGitFact, { status: "ok" }>,
  harness: SetupHarnessFact,
  options: Pick<PlanSetupConfigWriteOptions, "installHarnessHooks">,
): ConfigWritePlan {
  const coreProblem = existingConfigAppendCoreProblem(config, harness);
  if (coreProblem !== undefined) {
    return {
      operation: "blocked",
      path: config.path,
      reason: coreProblem,
    };
  }
  const appendedText = renderAppendText({
    git,
    harness,
    addProject: !config.hasProjectForRoot,
    addHarness: !config.configuredHarnesses.includes(harness.id),
    installHarnessHooks: options.installHarnessHooks === true,
  });
  if (appendedText.length === 0) {
    return {
      operation: "none",
      reason: "Config already includes this repository and selected harness.",
    };
  }
  return {
    operation: "append",
    path: config.path,
    content: `${config.source.trimEnd()}\n${appendedText}`,
    appendedText,
  };
}

function existingConfigAppendCoreProblem(
  config: Extract<SetupConfigFact, { status: "valid" }>,
  harness: SetupHarnessFact,
): string | undefined {
  if (config.matchedProject === undefined) {
    if (config.defaults.worktreeProvider !== "worktrunk") {
      return `Config defaults use worktree provider ${config.defaults.worktreeProvider}; setup will not rewrite existing defaults.`;
    }
    if (config.defaults.terminal !== "tmux") {
      return `Config defaults use terminal ${config.defaults.terminal}; setup will not rewrite existing defaults.`;
    }
    if (config.defaults.harness !== harness.id) {
      return `Config defaults use harness ${config.defaults.harness}; setup will not rewrite existing defaults.`;
    }
    return undefined;
  }

  if (config.matchedProject.worktreeProvider !== "worktrunk") {
    return `Project ${config.matchedProject.id} uses worktree provider ${config.matchedProject.worktreeProvider}; setup will not rewrite existing project defaults.`;
  }
  if (!config.matchedProject.worktrunkEnabled) {
    return `Project ${config.matchedProject.id} disables Worktrunk; setup will not rewrite existing project defaults.`;
  }
  if (config.matchedProject.terminal !== "tmux") {
    return `Project ${config.matchedProject.id} uses terminal ${config.matchedProject.terminal}; setup will not rewrite existing project defaults.`;
  }
  if (config.matchedProject.harness !== harness.id) {
    return `Project ${config.matchedProject.id} uses harness ${config.matchedProject.harness}; setup will not rewrite existing project defaults.`;
  }
  return undefined;
}

function renderAppendText(input: {
  git: Extract<SetupGitFact, { status: "ok" }>;
  harness: SetupHarnessFact;
  addProject: boolean;
  addHarness: boolean;
  installHarnessHooks: boolean;
}): string {
  const blocks: string[] = [];
  if (input.addHarness) {
    blocks.push(
      [
        `[harness.${input.harness.id}]`,
        "enabled = true",
        `command = ${tomlString(input.harness.command)}`,
        ...(input.installHarnessHooks && harnessSupportsHooks(input.harness.id)
          ? ["install_hooks = true"]
          : []),
      ].join("\n"),
    );
  }
  if (input.addProject) {
    blocks.push(
      [
        "[[projects]]",
        `id = ${tomlString(projectIdForGit(input.git))}`,
        `label = ${tomlString(input.git.repoName)}`,
        `root = ${tomlString(input.git.root)}`,
      ].join("\n"),
    );
  }
  return blocks.length === 0 ? "" : `\n${blocks.join("\n\n")}\n`;
}

function projectIdForGit(git: Extract<SetupGitFact, { status: "ok" }>): string {
  return stableName({
    profile: "id",
    display: [basename(git.root) || git.repoName],
    unique: [git.root],
    maxLength: 64,
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function harnessSupportsHooks(harness: string): boolean {
  return (
    harness === "claude" || harness === "codex" || harness === "cursor" || harness === "opencode"
  );
}

function detectedCommand(
  fact: { command: string; resolvedPath?: string },
  defaultCommand: string,
): string {
  if (fact.command !== defaultCommand || fact.command.includes("/")) {
    return fact.command;
  }
  return fact.resolvedPath ?? defaultCommand;
}

function detectedOptionalCommand(
  fact: { command: string; resolvedPath?: string },
  defaultCommand: string,
): string | undefined {
  if (fact.command !== defaultCommand || fact.command.includes("/")) {
    return fact.command;
  }
  return fact.resolvedPath;
}
