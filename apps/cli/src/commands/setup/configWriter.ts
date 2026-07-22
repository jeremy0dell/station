import { setHarnessInstallHooksInToml } from "@station/config";
import {
  harnessSupportsSetupHooks,
  isSupportedHarnessId,
  resolveSetupHarnessSelection,
  type SetupHarnessSelection,
} from "./harnessSelection.js";
import type {
  ConfigWritePlan,
  SetupConfigFact,
  SetupFacts,
  SetupHarnessFact,
  SupportedHarnessId,
} from "./model.js";

export type PlanSetupConfigWriteOptions = {
  harnessSelection?: SetupHarnessSelection;
  installWorktrunkHooks?: boolean;
  installHarnessHooks?: readonly SupportedHarnessId[];
};

export async function planSetupConfigWrite(
  facts: SetupFacts,
  options: PlanSetupConfigWriteOptions = {},
): Promise<ConfigWritePlan> {
  const harnessSelection = options.harnessSelection ?? resolveSetupHarnessSelection(facts);
  if (harnessSelection.selected.length === 0) {
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
      content: renderNewSetupConfig(harnessSelection.selected, facts, options),
    };
  }

  if (facts.config.status === "invalid") {
    return {
      operation: "blocked",
      path: facts.config.path,
      reason: facts.config.message,
    };
  }

  return planExistingConfigUpdate(facts.config, harnessSelection.selected, options, facts.homeDir);
}

export function renderNewSetupConfig(
  harnesses: readonly SetupHarnessFact[],
  facts?: Pick<SetupFacts, "worktrunk" | "tmux">,
  options: Pick<PlanSetupConfigWriteOptions, "installWorktrunkHooks" | "installHarnessHooks"> = {},
): string {
  const defaultHarness = harnesses[0];
  if (defaultHarness === undefined) throw new Error("New setup config requires an agent CLI.");
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
    `harness = ${tomlString(defaultHarness.id)}`,
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
    ...harnesses.flatMap((selectedHarness) => [
      ...renderHarnessBlock(
        selectedHarness,
        options.installHarnessHooks?.includes(selectedHarness.id) === true,
      ).split("\n"),
      "",
    ]),
  ].join("\n");
}

async function planExistingConfigUpdate(
  config: Extract<SetupConfigFact, { status: "valid" }>,
  harnesses: readonly SetupHarnessFact[],
  options: Pick<PlanSetupConfigWriteOptions, "installHarnessHooks">,
  homeDir: string,
): Promise<ConfigWritePlan> {
  const coreProblem = existingConfigUpdateCoreProblem(config);
  if (coreProblem !== undefined) {
    return {
      operation: "blocked",
      path: config.path,
      reason: coreProblem,
    };
  }

  let content = config.source;
  for (const harness of harnesses) {
    if (
      config.configuredHarnesses.includes(harness.id) &&
      !config.configuredHookHarnesses.includes(harness.id) &&
      options.installHarnessHooks?.includes(harness.id) === true
    ) {
      content = await setHarnessInstallHooksInToml(content, {
        harness: harness.id,
        installHooks: true,
        configPath: config.path,
        homeDir,
      });
    }
  }

  const appendedText = renderAppendText(
    harnesses.filter((harness) => !config.configuredHarnesses.includes(harness.id)),
    options.installHarnessHooks,
    preferredNewline(config.source),
  );
  if (appendedText.length > 0) {
    content = `${content}${content.endsWith("\n") ? "" : preferredNewline(content)}${appendedText}`;
  }
  if (content === config.source) {
    return {
      operation: "none",
      reason:
        harnesses.length === 1
          ? "Config already includes the selected harness and core defaults."
          : "Config already includes the selected harnesses and core defaults.",
    };
  }
  return {
    operation: "update",
    path: config.path,
    content,
  };
}

function existingConfigUpdateCoreProblem(
  config: Extract<SetupConfigFact, { status: "valid" }>,
): string | undefined {
  if (config.defaults.worktreeProvider !== "worktrunk") {
    return `Config defaults use worktree provider ${config.defaults.worktreeProvider}; setup will not rewrite existing defaults.`;
  }
  if (config.defaults.terminal !== "tmux") {
    return `Config defaults use terminal ${config.defaults.terminal}; setup will not rewrite existing defaults.`;
  }
  if (!isSupportedHarnessId(config.defaults.harness)) {
    return `Config defaults use unsupported harness ${config.defaults.harness}; setup will not rewrite existing defaults.`;
  }
  return undefined;
}

function renderAppendText(
  harnesses: readonly SetupHarnessFact[],
  installHarnessHooks: readonly SupportedHarnessId[] | undefined,
  newline = "\n",
): string {
  if (harnesses.length === 0) return "";
  const blocks = harnesses.map((harness) =>
    renderHarnessBlock(harness, installHarnessHooks?.includes(harness.id) === true).replaceAll(
      "\n",
      newline,
    ),
  );
  return `${newline}${blocks.join(`${newline}${newline}`)}${newline}`;
}

function renderHarnessBlock(harness: SetupHarnessFact, installHooks: boolean): string {
  return [
    `[harness.${harness.id}]`,
    "enabled = true",
    `command = ${tomlString(harness.command)}`,
    ...(installHooks && harnessSupportsSetupHooks(harness.id) ? ["install_hooks = true"] : []),
  ].join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function preferredNewline(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
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
