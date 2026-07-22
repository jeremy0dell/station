import { setHarnessInstallHooksInToml } from "@station/config";
import { isSupportedHarnessId, selectSetupHarnesses } from "./harnessSelection.js";
import type {
  ConfigWritePlan,
  SetupConfigFact,
  SetupFacts,
  SetupHarnessFact,
  SupportedHarnessId,
} from "./model.js";

export type PlanSetupConfigWriteOptions = {
  selectedHarness?: SetupHarnessFact;
  installWorktrunkHooks?: boolean;
  installHarnessHooks?: boolean | readonly SupportedHarnessId[];
};

export async function planSetupConfigWrite(
  facts: SetupFacts,
  options: PlanSetupConfigWriteOptions = {},
): Promise<ConfigWritePlan> {
  const selectedHarnesses = resolveConfigWriteHarnesses(facts, options.selectedHarness);
  const defaultHarness = selectedHarnesses[0];
  if (defaultHarness === undefined) {
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
      content: renderNewSetupConfig(defaultHarness, facts, options, selectedHarnesses),
    };
  }

  if (facts.config.status === "invalid") {
    return {
      operation: "blocked",
      path: facts.config.path,
      reason: facts.config.message,
    };
  }

  return planExistingConfigAppend(facts.config, selectedHarnesses, options, facts.homeDir);
}

export function renderNewSetupConfig(
  harness: SetupHarnessFact,
  facts?: Pick<SetupFacts, "worktrunk" | "tmux">,
  options: Pick<PlanSetupConfigWriteOptions, "installWorktrunkHooks" | "installHarnessHooks"> = {},
  harnesses: readonly SetupHarnessFact[] = [harness],
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
    ...harnesses.flatMap((selectedHarness) => [
      ...renderHarnessBlock(
        selectedHarness,
        installHarnessHookRequested(options.installHarnessHooks, selectedHarness.id, harness.id),
      ).split("\n"),
      "",
    ]),
  ].join("\n");
}

function resolveConfigWriteHarnesses(
  facts: SetupFacts,
  fallback: SetupHarnessFact | undefined,
): SetupHarnessFact[] {
  const configuredHarnesses =
    facts.config.status === "valid"
      ? [facts.config.defaults.harness, ...facts.config.configuredHarnesses]
          .filter(isSupportedHarnessId)
          .filter((harness, index, all) => all.indexOf(harness) === index)
      : undefined;
  const selectedHarnesses = selectSetupHarnesses(
    facts.harnesses,
    facts.selectedHarnesses ?? configuredHarnesses,
    facts.selectedHarness ?? fallback?.id,
  );
  return selectedHarnesses;
}

async function planExistingConfigAppend(
  config: Extract<SetupConfigFact, { status: "valid" }>,
  harnesses: readonly SetupHarnessFact[],
  options: Pick<PlanSetupConfigWriteOptions, "installHarnessHooks">,
  homeDir: string,
): Promise<ConfigWritePlan> {
  const coreProblem = existingConfigAppendCoreProblem(config);
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
      installHarnessHookRequested(options.installHarnessHooks, harness.id, harnesses[0]?.id)
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
    harnesses[0]?.id,
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
    operation: "append",
    path: config.path,
    content,
    appendedText,
  };
}

function existingConfigAppendCoreProblem(
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
  installHarnessHooks: boolean | readonly SupportedHarnessId[] | undefined,
  defaultHarness: SupportedHarnessId | undefined,
  newline = "\n",
): string {
  if (harnesses.length === 0) return "";
  const blocks = harnesses.map((harness) =>
    renderHarnessBlock(
      harness,
      installHarnessHookRequested(installHarnessHooks, harness.id, defaultHarness),
    ).replaceAll("\n", newline),
  );
  return `${newline}${blocks.join(`${newline}${newline}`)}${newline}`;
}

function renderHarnessBlock(harness: SetupHarnessFact, installHooks: boolean): string {
  return [
    `[harness.${harness.id}]`,
    "enabled = true",
    `command = ${tomlString(harness.command)}`,
    ...(installHooks && harnessSupportsHooks(harness.id) ? ["install_hooks = true"] : []),
  ].join("\n");
}

function installHarnessHookRequested(
  requested: boolean | readonly SupportedHarnessId[] | undefined,
  harness: SupportedHarnessId,
  defaultHarness: SupportedHarnessId | undefined,
): boolean {
  return Array.isArray(requested)
    ? requested.includes(harness)
    : requested === true && harness === defaultHarness;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function preferredNewline(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
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
