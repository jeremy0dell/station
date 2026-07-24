import { access } from "node:fs/promises";
import { applySetupPlan } from "../apply.js";
import { checkSetupTmuxBinding } from "../checks/tmuxBinding.js";
import { planSetupConfigWrite } from "../configWriter.js";
import {
  activateCompletedConfigWrite,
  applyOptions,
  collectForCommand,
  collectSetupPlanForCommand,
  coreReadyForConfigWrite,
  depsWithBrewBinPath,
  isConfigAction,
  isHookSetupAction,
  isInstallAction,
  isTmuxPopupBindingAction,
  markRequiredIncomplete,
} from "../flowUtils.js";
import {
  harnessInstallPlan,
  isHarnessInstallAction,
  missingHarnessInstallActions,
} from "../harnessInstall.js";
import { isSupportedHarnessId, type SetupHarnessSelection } from "../harnessSelection.js";
import { defaultPrompt, renderOptions, write } from "../io.js";
import type { SetupAction, SetupFacts, SetupPlan, SupportedHarnessId } from "../model.js";
import { buildSetupPlan } from "../planner.js";
import { formatCommand, renderSetupApplyResult, renderSetupPlan } from "../render.js";
import type {
  SetupCommandDeps,
  SetupCommandOptions,
  SetupCommandResult,
  SetupPromptAdapter,
} from "../types.js";

export async function runGuidedSetup(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
): Promise<SetupCommandResult> {
  const prompt = deps.prompt ?? defaultPrompt();
  try {
    return await runGuidedSetupWithPrompt(options, deps, prompt);
  } finally {
    await prompt.close?.();
  }
}

async function runGuidedSetupWithPrompt(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  prompt: SetupPromptAdapter,
): Promise<SetupCommandResult> {
  await write(
    deps,
    "Core setup: required tools and one or more agents. Add your first project in STATION.\n\n",
  );
  const initialFacts = await collectForCommand("apply", options, deps, {});

  // Bootstrap layer (macOS): Command Line Tools, then Homebrew — the prerequisites
  // for git and every brew-installed tool below. Resolving these can change what is
  // installable, so it runs before the plan is built.
  const bootstrap = await ensureBootstrapTools(initialFacts, options, deps, prompt);
  if (bootstrap.halt) return { code: 1 };
  const bootstrappedFacts = bootstrap.facts ?? initialFacts;

  const coreTools = await ensureRequiredTools(bootstrappedFacts, options, deps, prompt);
  if (coreTools.status === "halt") return { code: 1 };

  const availableHarnessFacts = await ensureHarnessAvailable(
    options,
    deps,
    prompt,
    coreTools.facts,
  );
  if (availableHarnessFacts === undefined) return { code: 1 };

  const reprobeDeps = depsWithBrewBinPath(depsWithUserBinPath(deps, availableHarnessFacts));
  const harnessChoice = await selectGuidedHarnesses(availableHarnessFacts, prompt, deps);
  if (harnessChoice.status === "halt") return { code: 1 };
  const selectedHarnessIds = harnessChoice.selectedHarnessIds;

  const linkedFacts = await maybeLinkStationLaunchers(
    availableHarnessFacts,
    options,
    reprobeDeps,
    prompt,
  );
  const hookPreferences = await promptHookPreferences(linkedFacts, prompt);
  const preflight = await collectSetupPlanForCommand("apply", options, reprobeDeps, {
    ...(selectedHarnessIds === undefined ? {} : { selectedHarnessIds }),
    planConfigWrite: true,
    ...hookPreferences,
  });
  const unavailableHarnessIds = findUnavailableRequiredHarnesses(preflight.harnessSelection);
  if (unavailableHarnessIds.length > 0) {
    await write(
      deps,
      `Required agent CLIs are unavailable: ${unavailableHarnessIds.join(", ")}.\n`,
    );
    return { code: 1 };
  }
  if (!(await confirmRequiredHarnessTracking(preflight.plan, prompt, deps))) return { code: 1 };
  if (!coreReadyForConfigWrite(preflight.plan)) {
    await write(deps, renderSetupApplyResult(preflight.plan, renderOptions(deps)));
    return { code: 1 };
  }

  const configActivation = await writeAndActivateConfig(
    preflight.plan,
    preflight.facts,
    prompt,
    deps,
  );
  if (configActivation.status === "halt") return { code: 1 };

  // Provider artifacts must target the config already activated by the Observer.
  if (!(await installSelectedHooks(preflight.plan, deps))) return { code: 1 };

  const tmuxPopupState = await collectGuidedPopupState({
    configWritten: configActivation.writtenPlan !== undefined,
    preflight,
    options,
    reprobeDeps,
    selectedHarnessIds,
  });
  await offerWorktrunkShellIntegration(preflight.plan, preflight.facts, prompt, deps);
  await offerTmuxPopupBinding({
    facts: tmuxPopupState.facts,
    plan: tmuxPopupState.plan,
    options,
    deps,
    prompt,
  });

  // Successful actions do not prove readiness; rebuild the plan from current config and artifacts.
  const finalState = await collectSetupPlanForCommand(
    "apply",
    options,
    reprobeDeps,
    selectedHarnessPlanInput(selectedHarnessIds),
  );
  await write(deps, renderSetupApplyResult(finalState.plan, renderOptions(deps)));
  return { code: finalState.plan.summary.requiredOk ? 0 : 1 };
}

type GuidedFactsResult = { status: "continue"; facts: SetupFacts } | { status: "halt" };

type GuidedHarnessChoice =
  | { status: "continue"; selectedHarnessIds: readonly SupportedHarnessId[] | undefined }
  | { status: "halt" };

type GuidedConfigActivation =
  | { status: "continue"; writtenPlan: SetupPlan | undefined }
  | { status: "halt" };

async function ensureRequiredTools(
  facts: SetupFacts,
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  prompt: SetupPromptAdapter,
): Promise<GuidedFactsResult> {
  const plan = buildSetupPlan(facts, { configWrite: await planSetupConfigWrite(facts) });
  await write(deps, renderSetupPlan(plan, renderOptions(deps)));
  const installActions = plan.actions.filter(
    (action) => isInstallAction(action) && action.selected,
  );
  if (installActions.length === 0) return { status: "continue", facts };

  if (!(await prompt.confirm("Install missing required tools?"))) {
    await write(deps, "No changes made.\n");
    return { status: "halt" };
  }
  const installResult = await applySetupPlan(
    plan,
    // A fresh Homebrew install usually has not updated the current process PATH yet.
    applyOptions(depsWithBrewBinPath(deps), {
      actionFilter: isInstallAction,
      announceActions: true,
      showCommandOutput: true,
    }),
  );
  if (installResult.failedAction !== undefined) {
    await write(
      deps,
      renderSetupApplyResult(markRequiredIncomplete(installResult.plan), renderOptions(deps)),
    );
    return { status: "halt" };
  }
  const refreshedFacts = await collectForCommand("apply", options, depsWithBrewBinPath(deps), {});
  return { status: "continue", facts: refreshedFacts };
}

async function selectGuidedHarnesses(
  facts: SetupFacts,
  prompt: SetupPromptAdapter,
  deps: SetupCommandDeps,
): Promise<GuidedHarnessChoice> {
  const availableHarnesses = facts.harnesses.filter((harness) => harness.status === "ok");
  if (availableHarnesses.length === 0) {
    await write(deps, renderSetupApplyResult(buildSetupPlan(facts), renderOptions(deps)));
    return { status: "halt" };
  }
  if (!shouldPromptHarnessSelection(facts, availableHarnesses.length)) {
    return { status: "continue", selectedHarnessIds: undefined };
  }

  const configuredDefault =
    facts.config.status === "valid" ? facts.config.defaults.harness : undefined;
  const orderedHarnesses = [...availableHarnesses].sort((left, right) => {
    if (left.id === configuredDefault) return -1;
    if (right.id === configuredDefault) return 1;
    return 0;
  });
  const selectedValues = await prompt.selectMany(
    "Select agent CLIs to prepare (comma-separated; the first is the default only for a new config).",
    orderedHarnesses.map((harness) => ({ value: harness.id, label: harness.label })),
  );
  const selectedHarnessIds = selectedValues.filter(isSupportedHarnessId);
  if (selectedHarnessIds.length === 0) {
    await write(deps, "Select at least one available agent CLI.\n");
    return { status: "halt" };
  }
  return { status: "continue", selectedHarnessIds };
}

function shouldPromptHarnessSelection(facts: SetupFacts, availableCount: number): boolean {
  return facts.config.status !== "invalid" && availableCount > 1;
}

function findUnavailableRequiredHarnesses(
  harnessSelection: SetupHarnessSelection,
): SupportedHarnessId[] {
  const selectedIds = new Set(harnessSelection.selected.map((harness) => harness.id));
  return harnessSelection.requiredHarnessIds.filter((id) => !selectedIds.has(id));
}

function selectedHarnessPlanInput(selectedHarnessIds: readonly SupportedHarnessId[] | undefined): {
  selectedHarnessIds?: readonly SupportedHarnessId[];
} {
  if (selectedHarnessIds === undefined) return {};
  return { selectedHarnessIds };
}

async function writeAndActivateConfig(
  plan: SetupPlan,
  facts: SetupFacts,
  prompt: SetupPromptAdapter,
  deps: SetupCommandDeps,
): Promise<GuidedConfigActivation> {
  const configWriteSelected = plan.actions.some(
    (action) => isConfigAction(action) && action.selected,
  );
  if (!configWriteSelected) return { status: "continue", writtenPlan: undefined };

  if (!(await prompt.confirm("Write core STATION config?"))) {
    await write(deps, "Config was not written.\n");
    return { status: "halt" };
  }
  const writeResult = await applySetupPlan(
    plan,
    applyOptions(deps, { actionFilter: isConfigAction, announceActions: true }),
  );
  if (writeResult.failedAction !== undefined) {
    await write(deps, "Config write failed. Run: stn setup plan\n");
    return { status: "halt" };
  }
  const activationError = await activateCompletedConfigWrite(writeResult.plan, facts.homeDir, deps);
  if (activationError !== undefined) return { status: "halt" };
  return { status: "continue", writtenPlan: writeResult.plan };
}

async function installSelectedHooks(plan: SetupPlan, deps: SetupCommandDeps): Promise<boolean> {
  const hookActions = plan.actions.filter((action) => isHookSetupAction(action) && action.selected);
  let failed = false;
  // Hook providers are independent; one failed installer must not suppress the rest.
  for (const action of hookActions) {
    const hookResult = await applySetupPlan(
      { ...plan, actions: [action] },
      applyOptions(deps, { announceActions: true, showCommandOutput: true }),
    );
    if (hookResult.failedAction !== undefined) failed = true;
  }
  if (failed) {
    await write(deps, "Hook install failed. Fix the install error, then run: stn setup\n");
  }
  return !failed;
}

type GuidedPopupState = { facts: SetupFacts; plan: SetupPlan };

type TmuxPopupInput = GuidedPopupState & {
  options: SetupCommandOptions;
  deps: SetupCommandDeps;
  prompt: SetupPromptAdapter;
};

function collectGuidedPopupState(input: {
  configWritten: boolean;
  preflight: GuidedPopupState;
  options: SetupCommandOptions;
  reprobeDeps: SetupCommandDeps;
  selectedHarnessIds: readonly SupportedHarnessId[] | undefined;
}): Promise<GuidedPopupState> {
  if (!input.configWritten) return Promise.resolve(input.preflight);
  return collectSetupPlanForCommand(
    "apply",
    input.options,
    input.reprobeDeps,
    selectedHarnessPlanInput(input.selectedHarnessIds),
  );
}

async function offerWorktrunkShellIntegration(
  plan: SetupPlan,
  facts: SetupFacts,
  prompt: SetupPromptAdapter,
  deps: SetupCommandDeps,
): Promise<void> {
  const action = plan.actions.find((candidate) => candidate.id === "worktrunk-shell-integration");
  if (action === undefined) return;
  if (await prompt.confirm("Install Worktrunk shell integration?")) {
    await installWorktrunkShellIntegration(action, plan, facts, deps);
  }
}

async function offerTmuxPopupBinding(input: TmuxPopupInput): Promise<void> {
  const { facts, plan, prompt, deps } = input;
  const bindingActions = plan.actions.filter(isTmuxPopupBindingAction);
  const popupCommand = formatCommand([facts.launchers.station.command, "popup"]);
  const bindingKey =
    facts.tmuxBinding.status === "conflict" ? undefined : facts.tmuxBinding.bindingKey;
  const currentFeedback = currentTmuxPopupFeedback(facts, popupCommand);

  let feedback = currentFeedback;
  if (bindingActions.length > 0 && bindingKey !== undefined) {
    const accepted = await prompt.confirm("Install or load tmux popup binding?");
    if (accepted) {
      feedback = await applyTmuxPopupBinding(input, bindingActions, bindingKey, popupCommand);
    } else {
      feedback =
        currentFeedback ?? `Tmux popup binding was not changed. Direct fallback: ${popupCommand}\n`;
    }
  }
  if (feedback !== undefined) await write(deps, feedback);
}

function currentTmuxPopupFeedback(facts: SetupFacts, popupCommand: string): string | undefined {
  if (facts.tmuxBinding.status !== "ok") return undefined;
  return renderTmuxPopupFeedback({
    persisted: true,
    liveLoaded: facts.tmuxBinding.liveStatus === "loaded",
    bindingKey: facts.tmuxBinding.bindingKey,
    popupCommand,
    repairIncomplete: false,
  });
}

async function applyTmuxPopupBinding(
  input: TmuxPopupInput,
  bindingActions: readonly SetupAction[],
  bindingKey: string,
  popupCommand: string,
): Promise<string> {
  const { facts, plan, deps } = input;
  const result = await applySetupPlan(
    {
      ...plan,
      actions: bindingActions.map((action) => ({ ...action, selected: true })),
    },
    applyOptions(deps, { announceActions: true, showCommandOutput: true }),
  );
  const completedIds = new Set(
    result.plan.actions.flatMap((action) => (action.status === "completed" ? [action.id] : [])),
  );
  const liveLoaded = await recheckTmuxPopupBinding(input, completedIds);
  return renderTmuxPopupFeedback({
    persisted: facts.tmuxBinding.status === "ok" || completedIds.has("tmux-popup-binding"),
    liveLoaded,
    bindingKey,
    popupCommand,
    repairIncomplete: result.failedAction !== undefined,
  });
}

async function recheckTmuxPopupBinding(
  input: TmuxPopupInput,
  completedIds: ReadonlySet<string>,
): Promise<boolean> {
  const { facts, options, deps } = input;
  if (!completedIds.has("tmux-live-popup-binding")) {
    return facts.tmuxBinding.liveStatus === "loaded";
  }
  const recheckOptions: Parameters<typeof checkSetupTmuxBinding>[0] = {
    homeDir: facts.homeDir,
    launcherCommand: facts.tmuxBinding.launcherCommand,
    runShellCommand: facts.tmuxBinding.runShellCommand,
    tmuxCommand: facts.tmux.resolvedPath ?? facts.tmux.command,
  };
  const env = deps.env ?? options.env;
  if (env !== undefined) recheckOptions.env = env;
  if (deps.fs !== undefined) recheckOptions.fs = deps.fs;
  if (deps.runner !== undefined) recheckOptions.runner = deps.runner;
  const rechecked = await checkSetupTmuxBinding(recheckOptions);
  return rechecked.liveStatus === "loaded";
}

async function installWorktrunkShellIntegration(
  action: SetupAction,
  plan: SetupPlan,
  facts: SetupFacts,
  deps: SetupCommandDeps,
): Promise<void> {
  const baseCommand = action.command;
  if (baseCommand === undefined) return;

  const integration = facts.worktrunkShellIntegration;
  const command =
    integration.shell === undefined ? baseCommand : [...baseCommand, integration.shell];
  if (integration.rcPath !== undefined && !(await pathExists(integration.rcPath, deps))) {
    await write(
      deps,
      [
        "Optional Worktrunk shell integration was not installed; core setup is complete.",
        `Active ${integration.shell} rc file not found: ${integration.rcPath}`,
        `Run: ${formatCommand(["touch", integration.rcPath])} && ${formatCommand(command)}`,
        "",
      ].join("\n"),
    );
    return;
  }

  const shellApplyOptions =
    applyOptions(deps, { announceActions: true, showCommandOutput: true }) ?? {};
  shellApplyOptions.onActionFailed = () => undefined;
  const result = await applySetupPlan(
    { ...plan, actions: [{ ...action, command, selected: true }] },
    shellApplyOptions,
  );
  if (result.failedAction !== undefined) {
    await write(
      deps,
      `Optional Worktrunk shell integration was not installed; core setup is complete.\nRun: ${formatCommand(command)}\n`,
    );
  }
}

async function pathExists(path: string, deps: SetupCommandDeps): Promise<boolean> {
  try {
    await (deps.fs?.access ?? access)(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    // Let Worktrunk surface other rc errors through the optional action-failure path.
    return true;
  }
}

function renderTmuxPopupFeedback(input: {
  persisted: boolean;
  liveLoaded: boolean;
  bindingKey: string;
  popupCommand: string;
  repairIncomplete: boolean;
}): string {
  let status: string;
  if (!input.persisted) {
    status = "Tmux popup binding was not persisted. Run stn setup to retry.";
  } else if (input.liveLoaded) {
    status = `Tmux popup binding: tmux prefix + ${input.bindingKey} is persisted and loaded in the current tmux server.`;
  } else {
    status = `Tmux popup binding: tmux prefix + ${input.bindingKey} is persisted for future tmux servers; no current server was live-loaded.`;
  }
  const lines = [status];
  if (input.repairIncomplete) {
    lines.push("Tmux popup binding repair was incomplete; run stn setup to retry.");
  }
  lines.push(`Direct fallback: ${input.popupCommand}`);
  return `${lines.join("\n")}\n`;
}

type HookPreferences = {
  installWorktrunkHooks?: boolean;
};

// Kicks the macOS bootstrap installers (Command Line Tools, then Homebrew) behind
// explicit prompts. Both need a TTY (a GUI dialog / a sudo password), so this path
// is guided-only — `setup apply --yes` stays guidance-only for these.
async function ensureBootstrapTools(
  facts: SetupFacts,
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  prompt: SetupPromptAdapter,
): Promise<{ halt?: boolean; facts?: SetupFacts }> {
  if (facts.xcode.status === "missing") {
    const accepted = await prompt.confirm(
      "Install Xcode Command Line Tools now? (runs xcode-select --install)",
    );
    if (accepted) {
      await applySetupPlan(
        harnessInstallPlan(facts, [commandLineToolsInstallAction()]),
        applyOptions(deps, { announceActions: true, showCommandOutput: true }),
      );
      // The CLT installer runs asynchronously in its own window; we cannot continue
      // until it finishes, so stop here and have the user re-run.
      await write(
        deps,
        "Command Line Tools installation started in a separate window. Finish it, then run: stn setup\n",
      );
    } else {
      await write(
        deps,
        "Install the Command Line Tools (xcode-select --install), then run: stn setup\n",
      );
    }
    return { halt: true };
  }

  if (facts.brew.status === "missing" && coreToolsNeedBrew(facts)) {
    const accepted = await prompt.confirm(
      "Install Homebrew now? (runs the official Homebrew installer)",
    );
    if (!accepted) {
      await write(deps, brewMissingCallout(facts));
      return {};
    }
    const result = await applySetupPlan(
      harnessInstallPlan(facts, [homebrewInstallAction()]),
      applyOptions(deps, { announceActions: true, showCommandOutput: true }),
    );
    if (result.failedAction !== undefined) {
      await write(
        deps,
        "Homebrew install failed. Install it from https://brew.sh, then run: stn setup\n",
      );
      return { halt: true };
    }
    // Re-probe with the brew prefix on PATH so the just-installed brew (and the
    // core tools it can now install) are detected in the main plan.
    return { facts: await collectForCommand("apply", options, depsWithBrewBinPath(deps), {}) };
  }

  return {};
}

function commandLineToolsInstallAction(): SetupAction {
  return {
    id: "install-command-line-tools",
    kind: "run-command",
    tier: "required",
    selected: true,
    label: "Install Command Line Tools",
    message: "Trigger the macOS Command Line Tools installer.",
    command: ["xcode-select", "--install"],
  };
}

function homebrewInstallAction(): SetupAction {
  return {
    id: "install-homebrew",
    kind: "run-command",
    tier: "required",
    selected: true,
    label: "Install Homebrew",
    message: "Run the official Homebrew installer.",
    command: [
      "/bin/bash",
      "-c",
      "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)",
    ],
  };
}

function coreToolsNeedBrew(facts: SetupFacts): boolean {
  return (
    facts.worktrunk.status !== "ok" ||
    facts.tmux.status !== "ok" ||
    facts.bun.status !== "ok" ||
    facts.diffnav.status !== "ok" ||
    facts.gitDelta.status !== "ok"
  );
}

function brewMissingCallout(facts: SetupFacts): string {
  const lines = [
    "Homebrew is required to install the missing core tools.",
    "  Install Homebrew first: https://brew.sh",
  ];
  // facts.xcode.applicable is true only on macOS, where brew itself needs the CLT.
  if (facts.xcode.applicable) {
    lines.push("  Command Line Tools: xcode-select --install");
  }
  return `${lines.join("\n")}\n\n`;
}

async function maybeLinkStationLaunchers(
  facts: SetupFacts,
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  prompt: SetupPromptAdapter,
): Promise<SetupFacts> {
  const plan = buildSetupPlan(facts, { configWrite: await planSetupConfigWrite(facts) });
  const action = plan.actions.find((candidate) => candidate.id === "link-station-launchers");
  if (action === undefined || !shouldPromptLauncherLink(facts)) return facts;

  const accepted = await prompt.confirm("Link STATION launchers globally?");
  if (!accepted) return facts;

  const result = await applySetupPlan(
    { ...plan, actions: [{ ...action, selected: true }] },
    applyOptions(deps, { announceActions: true, showCommandOutput: true }),
  );
  if (result.failedAction !== undefined) {
    await write(deps, "STATION launcher link failed. Continuing with checkout launcher paths.\n");
    return facts;
  }

  // Brew prefix here too: this result overwrites facts, so a brew-less re-probe would
  // drop the core tools installed earlier this session on a fresh Mac.
  return collectForCommand("apply", options, depsWithBrewBinPath(deps), {});
}

async function promptHookPreferences(
  facts: SetupFacts,
  prompt: SetupPromptAdapter,
): Promise<HookPreferences> {
  const preferences: HookPreferences = {};
  if (
    facts.worktrunk.status === "ok" &&
    (facts.config.status === "missing" ||
      (facts.config.status === "valid" && facts.config.worktrunkUseLifecycleHooks === true))
  ) {
    preferences.installWorktrunkHooks = await prompt.confirm("Install Worktrunk lifecycle hooks?");
  }
  return preferences;
}

async function confirmRequiredHarnessTracking(
  plan: SetupPlan,
  prompt: SetupPromptAdapter,
  deps: SetupCommandDeps,
): Promise<boolean> {
  const trackingActions = plan.actions.filter(
    (action) => action.selected && action.tier === "required" && action.data?.setupRole === "hook",
  );
  for (const action of trackingActions) {
    const accepted = await prompt.confirm(
      `${action.label}? Station requires tracking to observe the selected agent's activity.`,
    );
    if (!accepted) {
      await write(
        deps,
        "Required agent tracking was declined; config and provider tracking artifacts were not changed.\n",
      );
      return false;
    }
  }
  return true;
}

function shouldPromptLauncherLink(facts: SetupFacts): boolean {
  return [facts.launchers.station, facts.launchers.ingress, facts.launchers.tmuxPopup].some(
    (launcher) => launcher.source === "checkout",
  );
}

async function ensureHarnessAvailable(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  prompt: SetupPromptAdapter,
  facts: SetupFacts,
): Promise<SetupFacts | undefined> {
  if (facts.harnesses.some((harness) => harness.status === "ok")) {
    return facts;
  }

  await write(
    deps,
    [
      "",
      "No supported agent CLI is available.",
      "STATION needs one agent CLI. You can install one or more now.",
      "",
    ].join("\n"),
  );

  const selectedActions: SetupAction[] = [];
  for (const action of missingHarnessInstallActions(facts.harnesses)) {
    const command = action.command === undefined ? action.label : formatCommand(action.command);
    const accepted = await prompt.confirm(`${action.label}? (${command})`);
    if (accepted) {
      selectedActions.push({ ...action, selected: true });
    }
  }

  if (selectedActions.length === 0) {
    await write(
      deps,
      [
        "No agent CLI was installed.",
        "Install one supported agent CLI, then run:",
        "  stn setup",
        "",
      ].join("\n"),
    );
    return undefined;
  }

  const result = await applySetupPlan(
    harnessInstallPlan(facts, selectedActions),
    applyOptions(deps, {
      actionFilter: isHarnessInstallAction,
      announceActions: true,
      showCommandOutput: true,
    }),
  );
  if (result.failedAction !== undefined) {
    await write(deps, "Agent CLI install failed. Fix the install error, then run: stn setup\n");
    return undefined;
  }

  // Compose both prefixes: the agent CLI lands in ~/.local/bin, but the core tools
  // installed earlier this session live in the brew prefix — without it they re-read
  // as missing and overwrite the good facts, dead-ending config write on a fresh Mac.
  const refreshedFacts = await collectForCommand(
    "apply",
    options,
    depsWithBrewBinPath(depsWithUserBinPath(deps, facts)),
    {},
  );
  if (refreshedFacts.harnesses.some((harness) => harness.status === "ok")) {
    return refreshedFacts;
  }

  await write(
    deps,
    [
      "No supported agent CLI was detected after install.",
      "Make sure the installed CLI is on PATH, then run:",
      "  stn setup",
      "",
    ].join("\n"),
  );
  return undefined;
}

function depsWithUserBinPath(deps: SetupCommandDeps, facts: SetupFacts): SetupCommandDeps {
  const env = { ...(deps.env ?? process.env) };
  env.PATH = prependPath(`${facts.homeDir}/.local/bin`, env.PATH);
  return { ...deps, env };
}

function prependPath(path: string, existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) {
    return path;
  }
  return existing.split(":").includes(path) ? existing : `${path}:${existing}`;
}
