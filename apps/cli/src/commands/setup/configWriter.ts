import { selectSetupHarness } from "./harnessSelection.js";
import type { ConfigWritePlan, SetupConfigFact, SetupFacts, SetupHarnessFact } from "./model.js";

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
  if (facts.config.status === "missing") {
    return {
      operation: "create",
      path: facts.configPath,
      content: renderNewSetupConfig(selectedHarness, facts, options),
    };
  }

  if (facts.config.status === "invalid") {
    return {
      operation: "blocked",
      path: facts.config.path,
      reason: facts.config.message,
    };
  }

  return planExistingConfigAppend(facts.config, selectedHarness, options);
}

export function renderNewSetupConfig(
  harness: SetupHarnessFact,
  facts?: Pick<SetupFacts, "worktrunk" | "tmux">,
  options: Pick<PlanSetupConfigWriteOptions, "installWorktrunkHooks" | "installHarnessHooks"> = {},
): string {
  const worktrunkCommand =
    facts?.worktrunk === undefined ? "wt" : detectedCommand(facts.worktrunk, "wt");
  const tmuxCommand =
    facts?.tmux === undefined ? undefined : detectedOptionalCommand(facts.tmux, "tmux");
  const installWorktrunkHooks = options.installWorktrunkHooks === true;
  return [
    "schema_version = 1",
    "projects = []",
    "",
    "[observer]",
    'state_dir = "~/.local/state/station"',
    "",
    "[defaults]",
    'worktree_provider = "worktrunk"',
    'terminal = "tmux"',
    `harness = ${tomlString(harness.id)}`,
    'layout = "agent-shell"',
    "",
    "[worktree.worktrunk]",
    `command = ${tomlString(worktrunkCommand)}`,
    'managed_root = "~/.worktrees"',
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
  ].join("\n");
}

function resolveConfigWriteHarness(
  facts: SetupFacts,
  fallback: SetupHarnessFact | undefined,
): SetupHarnessFact | undefined {
  if (facts.config.status !== "valid") {
    return fallback;
  }
  const configuredHarness = facts.config.defaults.harness;
  return (
    facts.harnesses.find(
      (harness) => harness.id === configuredHarness && harness.status === "ok",
    ) ?? fallback
  );
}

function planExistingConfigAppend(
  config: Extract<SetupConfigFact, { status: "valid" }>,
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
    harness,
    addHarness: !config.configuredHarnesses.includes(harness.id),
    installHarnessHooks: options.installHarnessHooks === true,
  });
  if (appendedText.length === 0) {
    return {
      operation: "none",
      reason: "Config already includes the selected harness and core defaults.",
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

function renderAppendText(input: {
  harness: SetupHarnessFact;
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
  return blocks.length === 0 ? "" : `\n${blocks.join("\n\n")}\n`;
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
