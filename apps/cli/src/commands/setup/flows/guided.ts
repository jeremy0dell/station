import { access } from "node:fs/promises";
import type {
  SetupHarnessInstallOperation,
  SetupHomebrewInstallOperation,
  SetupIssue,
  SetupOperation,
  SetupXcodeToolsInstallOperation,
} from "@station/setup-core";
import { resolveSetupMessage, setupMessageRef } from "@station/setup-messages";
import { createSetupOperationAdapter } from "../adapters/operations.js";
import { applySetupPlan } from "../apply.js";
import { checkSetupTmuxBinding } from "../checks/tmuxBinding.js";
import {
  activateCompletedConfigWrite,
  applyOptions,
  type CollectedSetupPlan,
  collectForCommand,
  collectSetupPlanForCommand,
  collectSetupPlanFromFacts,
  coreReadyForConfigWrite,
  depsWithBrewBinPath,
  isConfigAction,
  isHookSetupAction,
  isInstallAction,
  isTmuxPopupBindingAction,
} from "../flowUtils.js";
import {
  harnessInstallPlan,
  isHarnessInstallAction,
  missingHarnessInstallActions,
} from "../harnessInstall.js";
import { isSupportedHarnessId, type SetupHarnessSelection } from "../harnessSelection.js";
import { defaultPrompt, setupPresenter } from "../io.js";
import type { SetupAction, SetupFacts, SetupPlan, SupportedHarnessId } from "../model.js";
import { buildSetupPlans } from "../planner.js";
import { overlaySetupActionStatuses } from "../presentation/projectSetupResult.js";
import { formatCommand } from "../render.js";
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
  const presenter = setupPresenter(deps);
  await presenter.writeMessage(setupMessageRef("setup.introduction"));
  await presenter.write("\n");
  const initialFacts = await collectForCommand("apply", options, deps, {});
  const initialPlan = buildSetupPlans(initialFacts);
  if (
    initialPlan.semanticPlan.issues.some((issue) =>
      mustHaltBeforePrerequisiteMutation(issue, initialPlan.semanticPlan.issues),
    )
  ) {
    await presenter.write(presenter.renderApplyResult(initialPlan.presentationView));
    return { code: 1 };
  }

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

  const reprobeDeps = depsWithBrewBinPath(depsWithHarnessBinPaths(deps, availableHarnessFacts));
  const harnessChoice = await selectGuidedHarnesses(availableHarnessFacts, prompt, deps);
  if (harnessChoice.status === "halt") return { code: 1 };
  const selectedHarnessIds = harnessChoice.selectedHarnessIds;

  const linkedFacts = await maybeLinkStationLaunchers(
    availableHarnessFacts,
    options,
    reprobeDeps,
    prompt,
  );
  const hookPreferences = await promptHookPreferences(linkedFacts, prompt, deps);
  const preflight = await collectSetupPlanForCommand("apply", options, reprobeDeps, {
    ...(selectedHarnessIds === undefined ? {} : { selectedHarnessIds }),
    planConfigWrite: true,
    ...hookPreferences,
  });
  const unavailableHarnessIds = findUnavailableRequiredHarnesses(preflight.harnessSelection);
  if (unavailableHarnessIds.length > 0) {
    await presenter.writeMessage(
      setupMessageRef("guided.required-harnesses-unavailable", {
        harnesses: unavailableHarnessIds.join(", "),
      }),
    );
    return { code: 1 };
  }
  if (!(await confirmRequiredHarnessTracking(preflight.plan, prompt, deps))) return { code: 1 };
  if (!coreReadyForConfigWrite(preflight.plan)) {
    await presenter.write(presenter.renderApplyResult(preflight.presentationView));
    return { code: 1 };
  }

  const configActivation = await writeAndActivateConfig(preflight, prompt, deps);
  if (configActivation.status === "halt") return { code: 1 };

  // Provider artifacts must target the config already activated by the Observer.
  const trackingSucceeded = await installSelectedHooks(preflight, deps);

  const tmuxPopupState = await collectGuidedPopupState({
    configWritten: configActivation.writtenPlan !== undefined,
    preflight,
    options,
    reprobeDeps,
    selectedHarnessIds,
  });
  await offerWorktrunkShellIntegration(preflight, prompt, deps);
  await offerTmuxPopupBinding({ ...tmuxPopupState, options, deps, prompt });

  // Operation outcomes do not prove readiness; rebuild the plan from current config and artifacts.
  const finalState = await collectSetupPlanForCommand(
    "apply",
    options,
    reprobeDeps,
    selectedHarnessPlanInput(selectedHarnessIds),
  );
  await presenter.write(presenter.renderApplyResult(finalState.presentationView));
  return { code: trackingSucceeded && finalState.plan.summary.requiredOk ? 0 : 1 };
}

type GuidedFactsResult = { status: "continue"; facts: SetupFacts } | { status: "halt" };

function isGuidedPrerequisiteIssue(issue: SetupIssue): boolean {
  switch (issue.code) {
    case "state-directory-unwritable":
    case "xcode-tools-missing":
    case "git-unavailable":
      return true;
    case "tool-missing":
      return issue.tier === "required";
    default:
      return false;
  }
}

function mustHaltBeforePrerequisiteMutation(
  issue: SetupIssue,
  issues: readonly SetupIssue[],
): boolean {
  if (!isGuidedPrerequisiteIssue(issue)) return false;
  // Missing Command Line Tools and required tools continue into guided repair; state-dir or unrecoverable Git failure stops before mutation.
  if (issue.code === "state-directory-unwritable") return true;
  return (
    issue.code === "git-unavailable" &&
    !issues.some((candidate) => candidate.code === "xcode-tools-missing")
  );
}

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
  const installDeps = depsWithBrewBinPath(deps);
  const initialState = await collectSetupPlanFromFacts(facts, installDeps, {
    planConfigWrite: true,
  });
  const plan = initialState.plan;
  const presenter = setupPresenter(deps);
  const installActions = plan.actions.filter(
    (action) => isInstallAction(action) && action.selected,
  );
  if (installActions.length === 0) {
    if (
      initialState.semanticPlan.issues.some(
        (issue) => isGuidedPrerequisiteIssue(issue) && issue.code === "tool-missing",
      )
    ) {
      await presenter.write(presenter.renderPlan(initialState.presentationView));
    }
    return { status: "continue", facts: initialState.facts };
  }
  await presenter.write(presenter.renderPlan(initialState.presentationView));

  if (!(await prompt.confirm(presenter.prompt(setupMessageRef("guided.tools-prompt"))))) {
    await presenter.writeMessage(setupMessageRef("guided.no-changes"));
    return { status: "halt" };
  }
  const installResult = await withPromptPaused(prompt, () =>
    applySetupPlan(
      plan,
      // A fresh Homebrew install usually has not updated the current process PATH yet.
      applyOptions(installDeps, {
        actionFilter: isInstallAction,
        announceActions: true,
        showCommandOutput: true,
        execution: initialState,
      }),
    ),
  );
  if (installResult.failedAction !== undefined) {
    const finalFacts = await collectForCommand("apply", options, depsWithBrewBinPath(deps), {});
    const finalState = await collectSetupPlanFromFacts(finalFacts, deps, {});
    await presenter.write(presenter.renderApplyResult(finalState.presentationView));
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
    const view = buildSetupPlans(facts).presentationView;
    const presenter = setupPresenter(deps);
    await presenter.write(presenter.renderApplyResult(view));
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
  const choices = orderedHarnesses.map((harness) => ({
    value: harness.id,
    label: harness.label,
  }));
  while (true) {
    const selectedValues = await prompt.selectMany(
      setupPresenter(deps).prompt(setupMessageRef("guided.harness-select-prompt")),
      choices,
    );
    const selectedHarnessIds = selectedValues.filter(isSupportedHarnessId);
    if (selectedHarnessIds.length > 0) {
      return { status: "continue", selectedHarnessIds };
    }
    await setupPresenter(deps).writeMessage(setupMessageRef("guided.harness-select-required"));
  }
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
  collected: CollectedSetupPlan,
  prompt: SetupPromptAdapter,
  deps: SetupCommandDeps,
): Promise<GuidedConfigActivation> {
  const { plan } = collected;
  const configWriteSelected = plan.actions.some(
    (action) => isConfigAction(action) && action.selected,
  );
  if (!configWriteSelected) return { status: "continue", writtenPlan: undefined };

  const presenter = setupPresenter(deps);
  if (!(await prompt.confirm(presenter.prompt(setupMessageRef("guided.config-write-prompt"))))) {
    await presenter.writeMessage(setupMessageRef("guided.config-not-written"));
    return { status: "halt" };
  }
  const writeResult = await applySetupPlan(
    plan,
    applyOptions(deps, {
      actionFilter: isConfigAction,
      announceActions: true,
      execution: collected,
    }),
  );
  if (writeResult.failedAction !== undefined) {
    const failedView = overlaySetupActionStatuses(
      collected.presentationView,
      writeResult.plan.actions,
    );
    await presenter.write(presenter.renderApplyResult(failedView));
    return { status: "halt" };
  }
  const activationError = await activateCompletedConfigWrite(collected, deps);
  if (activationError !== undefined) return { status: "halt" };
  return { status: "continue", writtenPlan: writeResult.plan };
}

async function installSelectedHooks(
  collected: CollectedSetupPlan,
  deps: SetupCommandDeps,
): Promise<boolean> {
  const hookActions = collected.plan.actions.filter(
    (action) => isHookSetupAction(action) && action.selected,
  );
  let failed = false;
  // Hook providers are independent; one failed installer must not suppress the rest.
  for (const action of hookActions) {
    const hookResult = await applySetupPlan(
      { ...collected.plan, actions: [action] },
      applyOptions(deps, {
        announceActions: true,
        showCommandOutput: true,
        execution: collected,
      }),
    );
    if (hookResult.failedAction !== undefined) failed = true;
  }
  if (failed) {
    await setupPresenter(deps).writeMessage(setupMessageRef("guided.hook-install-failed"));
  }
  return !failed;
}

type GuidedPopupState = CollectedSetupPlan;

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
  collected: CollectedSetupPlan,
  prompt: SetupPromptAdapter,
  deps: SetupCommandDeps,
): Promise<void> {
  const action = collected.plan.actions.find(
    (candidate) => candidate.id === "worktrunk-shell-integration",
  );
  if (action === undefined) return;
  if (
    await prompt.confirm(
      setupPresenter(deps).prompt(setupMessageRef("guided.worktrunk-shell-prompt")),
    )
  ) {
    await installWorktrunkShellIntegration(action, collected, deps);
  }
}

async function offerTmuxPopupBinding(input: TmuxPopupInput): Promise<void> {
  const { facts, plan, prompt, deps } = input;
  const bindingActions = plan.actions.filter(isTmuxPopupBindingAction);
  const popupCommand = formatCommand([facts.launchers.station.command, "popup"]);
  const bindingKey =
    facts.tmuxBinding.status === "conflict" ? undefined : facts.tmuxBinding.bindingKey;
  const currentFeedback = currentTmuxPopupFeedback(facts, popupCommand, deps);

  let feedback = currentFeedback;
  if (bindingActions.length > 0 && bindingKey !== undefined) {
    const accepted = await prompt.confirm(
      setupPresenter(deps).prompt(setupMessageRef("guided.tmux-popup-prompt")),
    );
    if (accepted) {
      feedback = await applyTmuxPopupBinding(input, bindingActions, bindingKey, popupCommand);
    } else {
      const presenter = setupPresenter(deps);
      feedback =
        currentFeedback ??
        `${presenter.text(setupMessageRef("guided.tmux-not-changed"))}\n${presenter.text(
          setupMessageRef("guided.direct-fallback", { command: popupCommand }),
        )}\n`;
    }
  }
  if (feedback !== undefined) await setupPresenter(deps).write(feedback);
}

function currentTmuxPopupFeedback(
  facts: SetupFacts,
  popupCommand: string,
  deps: SetupCommandDeps,
): string | undefined {
  if (facts.tmuxBinding.status !== "ok") return undefined;
  return renderTmuxPopupFeedback(
    {
      persisted: true,
      liveLoaded: facts.tmuxBinding.liveStatus === "loaded",
      bindingKey: facts.tmuxBinding.bindingKey,
      popupCommand,
      repairIncomplete: false,
    },
    deps,
  );
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
    applyOptions(deps, {
      announceActions: true,
      showCommandOutput: true,
      execution: input,
    }),
  );
  const completedIds = new Set(
    result.plan.actions.flatMap((action) => (action.status === "completed" ? [action.id] : [])),
  );
  const liveLoaded = await recheckTmuxPopupBinding(input, completedIds);
  return renderTmuxPopupFeedback(
    {
      persisted: facts.tmuxBinding.status === "ok" || completedIds.has("tmux-popup-binding"),
      liveLoaded,
      bindingKey,
      popupCommand,
      repairIncomplete: result.failedAction !== undefined,
    },
    deps,
  );
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
  collected: CollectedSetupPlan,
  deps: SetupCommandDeps,
): Promise<void> {
  const { facts, plan } = collected;
  const baseCommand = action.command;
  if (baseCommand === undefined) return;

  const integration = facts.worktrunkShellIntegration;
  const command =
    integration.shell === undefined ? baseCommand : [...baseCommand, integration.shell];
  const presenter = setupPresenter(deps);
  if (integration.rcPath !== undefined && !(await pathExists(integration.rcPath, deps))) {
    const recoveryCommand = `${formatCommand(["touch", integration.rcPath])} && ${formatCommand(command)}`;
    await presenter.write(
      [
        presenter.text(setupMessageRef("guided.worktrunk-shell-missing")),
        presenter.text(
          setupMessageRef("guided.active-rc-missing", {
            shell: integration.shell ?? "shell",
            path: integration.rcPath,
          }),
        ),
        presenter.text(setupMessageRef("recovery.run-command", { command: recoveryCommand })),
        "",
      ].join("\n"),
    );
    return;
  }

  const shellApplyOptions =
    applyOptions(deps, {
      announceActions: true,
      showCommandOutput: true,
      execution: collected,
    }) ?? {};
  // Suppress the generic failure line because this optional path emits one tailored recovery block below.
  shellApplyOptions.onActionFailed = () => undefined;
  const result = await applySetupPlan(
    { ...plan, actions: [{ ...action, command, selected: true }] },
    shellApplyOptions,
  );
  if (result.failedAction !== undefined) {
    await presenter.write(
      `${presenter.text(setupMessageRef("guided.worktrunk-shell-missing"))}\n${presenter.text(
        setupMessageRef("recovery.run-command", { command: formatCommand(command) }),
      )}\n`,
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

function renderTmuxPopupFeedback(
  input: {
    persisted: boolean;
    liveLoaded: boolean;
    bindingKey: string;
    popupCommand: string;
    repairIncomplete: boolean;
  },
  deps: SetupCommandDeps,
): string {
  const presenter = setupPresenter(deps);
  const status = !input.persisted
    ? presenter.text(setupMessageRef("guided.tmux-not-persisted"))
    : input.liveLoaded
      ? presenter.text(setupMessageRef("guided.tmux-loaded", { key: input.bindingKey }))
      : presenter.text(setupMessageRef("guided.tmux-future", { key: input.bindingKey }));
  const lines = [status];
  if (input.repairIncomplete) {
    lines.push(presenter.text(setupMessageRef("guided.tmux-repair-incomplete")));
  }
  lines.push(
    presenter.text(setupMessageRef("guided.direct-fallback", { command: input.popupCommand })),
  );
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
  const presenter = setupPresenter(deps);
  if (facts.xcode.status === "missing") {
    const accepted = await prompt.confirm(
      presenter.prompt(setupMessageRef("guided.command-line-tools-prompt")),
    );
    if (accepted) {
      const installResult = await withPromptPaused(prompt, () =>
        applySetupPlan(
          harnessInstallPlan(facts, [commandLineToolsInstallAction()]),
          applyOptions(deps, {
            announceActions: true,
            showCommandOutput: true,
            execution: standaloneOperationExecution(
              facts,
              deps,
              "install-command-line-tools",
              commandLineToolsOperation(),
            ),
          }),
        ),
      );
      if (installResult.failedAction === undefined) {
        // The CLT installer runs asynchronously in its own window; setup cannot continue until it finishes.
        await presenter.writeMessage(setupMessageRef("guided.command-line-tools-started"));
      } else {
        await presenter.writeMessage(setupMessageRef("guided.command-line-tools-failed"));
      }
    } else {
      await presenter.writeMessage(setupMessageRef("guided.command-line-tools-declined"));
    }
    return { halt: true };
  }

  if (facts.brew.status === "missing" && setupShouldOfferBrew(facts)) {
    const requiredForCoreTools = coreToolsNeedBrew(facts);
    const accepted = await prompt.confirm(
      presenter.prompt(setupMessageRef("guided.homebrew-prompt")),
    );
    if (!accepted) {
      await presenter.write(brewMissingCallout(facts));
      return {};
    }
    await presenter.write(
      `\n${presenter.text(setupMessageRef("guided.homebrew-installing"))}\n${presenter.text(
        setupMessageRef("guided.external-output"),
      )}\n\n`,
    );
    const result = await withPromptPaused(prompt, () =>
      applySetupPlan(
        harnessInstallPlan(facts, [homebrewInstallAction()]),
        applyOptions(deps, {
          showCommandOutput: true,
          execution: standaloneOperationExecution(
            facts,
            deps,
            "install-homebrew",
            homebrewOperation(),
          ),
        }),
      ),
    );
    if (result.failedAction !== undefined) {
      await presenter.write(`\n${presenter.text(setupMessageRef("guided.homebrew-failed"))}\n`);
      if (requiredForCoreTools) {
        await presenter.writeMessage(setupMessageRef("guided.homebrew-manual"));
        return { halt: true };
      }
      await presenter.writeMessage(setupMessageRef("guided.homebrew-continue"));
      return {};
    }
    await presenter.write(`\n${presenter.text(setupMessageRef("guided.homebrew-complete"))}\n`);
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
    label: resolveSetupMessage(
      setupMessageRef("action.install-label", { label: "Command Line Tools" }),
    ),
    message: resolveSetupMessage(setupMessageRef("installer.command-line-tools")),
    command: ["xcode-select", "--install"],
  };
}

export function homebrewInstallAction(): SetupAction {
  return {
    id: "install-homebrew",
    kind: "run-command",
    tier: "required",
    selected: true,
    label: resolveSetupMessage(setupMessageRef("action.install-label", { label: "Homebrew" })),
    message: resolveSetupMessage(setupMessageRef("installer.homebrew")),
    command: [
      "/bin/bash",
      "-c",
      [
        "set -eu",
        'installer="$(mktemp)"',
        "trap 'rm -f \"$installer\"' EXIT",
        'curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer"',
        '/bin/bash "$installer"',
      ].join("; "),
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

function setupShouldOfferBrew(facts: SetupFacts): boolean {
  return (
    coreToolsNeedBrew(facts) ||
    (facts.xcode.applicable && !facts.harnesses.some((harness) => harness.status === "ok"))
  );
}

function brewMissingCallout(facts: SetupFacts): string {
  if (!coreToolsNeedBrew(facts)) {
    return `${resolveSetupMessage(setupMessageRef("guided.homebrew-agents-only"))}\n\n`;
  }
  const lines = [
    resolveSetupMessage(setupMessageRef("guided.homebrew-core-required")),
    `  ${resolveSetupMessage(setupMessageRef("guided.homebrew-url"))}`,
  ];
  // facts.xcode.applicable is true only on macOS, where brew itself needs the CLT.
  if (facts.xcode.applicable) {
    lines.push(`  ${resolveSetupMessage(setupMessageRef("guided.command-line-tools-hint"))}`);
  }
  return `${lines.join("\n")}\n\n`;
}

async function maybeLinkStationLaunchers(
  facts: SetupFacts,
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  prompt: SetupPromptAdapter,
): Promise<SetupFacts> {
  const planned = await collectSetupPlanFromFacts(facts, deps, { planConfigWrite: true });
  const action = planned.plan.actions.find(
    (candidate) => candidate.id === "link-station-launchers",
  );
  if (action === undefined || !shouldPromptLauncherLink(facts)) return facts;

  const presenter = setupPresenter(deps);
  const accepted = await prompt.confirm(
    presenter.prompt(setupMessageRef("guided.launcher-link-prompt")),
  );
  if (!accepted) return facts;

  const result = await applySetupPlan(
    { ...planned.plan, actions: [{ ...action, selected: true }] },
    applyOptions(deps, {
      announceActions: true,
      showCommandOutput: true,
      execution: planned,
    }),
  );
  if (result.failedAction !== undefined) {
    await presenter.writeMessage(setupMessageRef("guided.launcher-link-failed"));
    return facts;
  }

  // Brew prefix here too: this result overwrites facts, so a brew-less re-probe would
  // drop the core tools installed earlier this session on a fresh Mac.
  return collectForCommand("apply", options, depsWithBrewBinPath(deps), {});
}

async function promptHookPreferences(
  facts: SetupFacts,
  prompt: SetupPromptAdapter,
  deps: SetupCommandDeps,
): Promise<HookPreferences> {
  const preferences: HookPreferences = {};
  if (
    facts.worktrunk.status === "ok" &&
    (facts.config.status === "missing" ||
      (facts.config.status === "valid" && facts.config.worktrunkUseLifecycleHooks === true))
  ) {
    preferences.installWorktrunkHooks = await prompt.confirm(
      setupPresenter(deps).prompt(setupMessageRef("guided.worktrunk-hooks-prompt")),
    );
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
  const presenter = setupPresenter(deps);
  for (const action of trackingActions) {
    const accepted = await prompt.confirm(
      presenter.prompt(setupMessageRef("guided.tracking-consent-prompt", { label: action.label })),
    );
    if (!accepted) {
      await presenter.writeMessage(setupMessageRef("guided.tracking-declined"));
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

  const presenter = setupPresenter(deps);
  await presenter.write(
    [
      "",
      presenter.text(setupMessageRef("guided.no-agent-title")),
      presenter.text(setupMessageRef("guided.no-agent-explanation")),
      "",
    ].join("\n"),
  );

  const selectedActions: SetupAction[] = [];
  for (const action of missingHarnessInstallActions(facts.harnesses, {
    brewAvailable: facts.brew.status === "ok",
    homeDir: facts.homeDir,
    macos: facts.xcode.applicable,
  })) {
    const accepted = await prompt.confirm(
      presenter.prompt(
        setupMessageRef("guided.installer-prompt", {
          label: action.label,
          description: action.message,
        }),
      ),
    );
    if (accepted) {
      selectedActions.push({ ...action, selected: true });
    }
  }

  if (selectedActions.length === 0) {
    await presenter.write(
      [
        presenter.text(setupMessageRef("guided.no-agent-installed")),
        presenter.text(setupMessageRef("guided.install-one-agent")),
        "  stn setup",
        "",
      ].join("\n"),
    );
    return undefined;
  }

  const installDeps = depsWithBrewBinPath(depsWithHarnessBinPaths(deps, facts));
  const failedHarnessIds = new Set<SupportedHarnessId>();
  for (const action of selectedActions) {
    const harnessId = action.data?.harness;
    const harness = facts.harnesses.find((candidate) => candidate.id === harnessId);
    const label = harness?.label ?? action.label;
    await presenter.write(
      `\n${presenter.text(setupMessageRef("guided.installing-agent", { label }))}\n${presenter.text(
        setupMessageRef("guided.external-output"),
      )}\n\n`,
    );
    const result = await withPromptPaused(prompt, () =>
      applySetupPlan(
        harnessInstallPlan(facts, [action]),
        applyOptions(installDeps, {
          actionFilter: isHarnessInstallAction,
          showCommandOutput: true,
          execution: standaloneOperationExecution(
            facts,
            installDeps,
            action.id,
            harnessInstallOperation(harnessId),
          ),
        }),
      ),
    );
    if (result.failedAction === undefined) {
      await presenter.write(
        `\n${presenter.text(setupMessageRef("guided.agent-install-complete", { label }))}\n`,
      );
    } else {
      await presenter.write(
        `\n${presenter.text(setupMessageRef("guided.agent-install-failed", { label }))}\n`,
      );
    }
    if (
      result.failedAction !== undefined &&
      harnessId !== undefined &&
      isSupportedHarnessId(harnessId)
    ) {
      failedHarnessIds.add(harnessId);
    }
  }

  const refreshedFacts = await collectForCommand("apply", options, installDeps, {});
  const stillMissing = selectedActions.flatMap((action) => {
    const harnessId = action.data?.harness;
    if (harnessId === undefined || !isSupportedHarnessId(harnessId)) return [];
    const available = refreshedFacts.harnesses.some(
      (harness) => harness.id === harnessId && harness.status === "ok",
    );
    return available ? [] : [harnessId];
  });
  for (const harnessId of stillMissing) failedHarnessIds.add(harnessId);

  if (failedHarnessIds.size > 0) {
    const labels = refreshedFacts.harnesses.flatMap((harness) =>
      failedHarnessIds.has(harness.id) ? [`  - ${harness.label}`] : [],
    );
    await presenter.write(
      [presenter.text(setupMessageRef("guided.agents-unavailable")), ...labels, ""].join("\n"),
    );
  }

  if (refreshedFacts.harnesses.some((harness) => harness.status === "ok")) {
    return refreshedFacts;
  }

  await presenter.write(
    [
      presenter.text(setupMessageRef("guided.no-agent-detected")),
      presenter.text(setupMessageRef("guided.agent-path-hint")),
      "  stn setup",
      "",
    ].join("\n"),
  );
  return undefined;
}

function depsWithHarnessBinPaths(deps: SetupCommandDeps, facts: SetupFacts): SetupCommandDeps {
  const env = { ...(deps.env ?? process.env) };
  env.PATH = prependPath(`${facts.homeDir}/.opencode/bin`, env.PATH);
  env.PATH = prependPath(`${facts.homeDir}/.local/bin`, env.PATH);
  return { ...deps, env };
}

function prependPath(path: string, existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) {
    return path;
  }
  return existing.split(":").includes(path) ? existing : `${path}:${existing}`;
}

function standaloneOperationExecution(
  facts: SetupFacts,
  deps: SetupCommandDeps,
  actionId: string,
  operation: SetupOperation,
): Pick<CollectedSetupPlan, "operationBindings" | "executeOperation"> {
  return {
    operationBindings: [{ actionId, operation }],
    executeOperation: createSetupOperationAdapter({ facts, deps }),
  };
}

function commandLineToolsOperation(): SetupXcodeToolsInstallOperation {
  return {
    id: "install:xcode-command-line-tools",
    kind: "install-xcode-command-line-tools",
    tier: "required",
    selected: true,
  };
}

function homebrewOperation(): SetupHomebrewInstallOperation {
  return {
    id: "install:homebrew",
    kind: "install-homebrew",
    tier: "required",
    selected: true,
  };
}

function harnessInstallOperation(harnessId: string | undefined): SetupHarnessInstallOperation {
  if (harnessId === undefined || !isSupportedHarnessId(harnessId)) {
    throw new Error("Harness install action requires a supported harness.");
  }
  return {
    id: `install-harness:${harnessId}`,
    kind: "install-harness",
    tier: "required",
    selected: true,
    harnessId,
  };
}

async function withPromptPaused<T>(prompt: SetupPromptAdapter, task: () => Promise<T>): Promise<T> {
  // Readline must release stdin while an inherited-stdio installer owns the terminal.
  prompt.pause?.();
  try {
    return await task();
  } finally {
    prompt.resume?.();
  }
}
