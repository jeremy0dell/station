import type { SafeError } from "@station/contracts";
import {
  assessSetupPlan,
  type SetupEditableIntent,
  type SetupOperation,
  type SetupOperationOutcome,
  type SetupOperationProgress,
  type SetupSessionState,
  type SupportedHarnessId,
} from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import type { SetupComposition, SetupSessionProjection } from "../composition.js";
import { isSupportedHarnessId } from "../harnessSelection.js";
import type { SetupFacts } from "../model.js";
import { overlaySetupOperationOutcomes } from "../presentation/projectSetupResult.js";
import type { TextSetupPresenter } from "../presenters/text.js";
import { formatCommand } from "../render.js";
import type {
  SetupCommandDeps,
  SetupCommandOptions,
  SetupCommandResult,
  SetupPromptAdapter,
  SetupPromptAnswer,
  SetupPromptChoice,
} from "../types.js";

type CreateGuidedSetupComposition = (
  options: SetupCommandOptions,
  progress: SetupOperationProgress,
  initialIntent: SetupEditableIntent,
) => SetupComposition;

type GuidedPromptResult<T> =
  | { readonly kind: "answered"; readonly value: T }
  | { readonly kind: "cancelled" };

type GuidedHarnessSelection =
  | { readonly kind: "selected"; readonly harnessIds: SupportedHarnessId[] }
  | { readonly kind: "cancelled" }
  | { readonly kind: "blocked" };

/**
 * ADAPTER
 *
 * Drives Clack-guided setup through one injected composition while normalizing typed cancellation and preserving application-owned mutation ordering.
 */
export async function runGuidedSetupSession(
  options: SetupCommandOptions,
  _deps: SetupCommandDeps,
  createComposition: CreateGuidedSetupComposition,
): Promise<SetupCommandResult> {
  const initialIntent = guidedIntent();
  // Progress cannot fire during construction; callbacks resolve the composition after the factory assigns it.
  let composition: SetupComposition | undefined;
  composition = createComposition(
    options,
    {
      started: (operation) => renderOperationStarted(requireComposition(composition), operation),
      finished: (operation, outcome) =>
        renderOperationFinished(requireComposition(composition), operation, outcome),
    },
    initialIntent,
  );
  if (!composition.guided.isInteractiveTerminal()) {
    await renderInteractiveTerminalRequirement(composition);
    return { code: 1 };
  }
  return driveGuidedSession(composition, initialIntent);
}

async function driveGuidedSession(
  composition: SetupComposition,
  initialIntent: SetupEditableIntent,
): Promise<SetupCommandResult> {
  const presenter = composition.text;
  const prompt = composition.guided;
  let intent = initialIntent;

  prompt.intro(presenter.text(setupMessageRef("guided.heading")));
  prompt.logInfo(presenter.text(setupMessageRef("setup.introduction")));
  prompt.logStep(presenter.text(setupMessageRef("guided.checking")));

  let state = await composition.session.application.start();
  let projection = await requireProjection(composition, state);
  if (projection === undefined) return finishIncomplete(composition);
  const initialPlan = projection.session.plan;
  if (initialPlan === undefined || !assessSetupPlan(initialPlan).canPrepare) {
    await presenter.write(presenter.renderApplyResult(projection.view));
    return finishIncomplete(composition);
  }

  if (composition.session.snapshot()?.facts.xcode.status === "missing") {
    const answer = await confirm(
      composition,
      presenter.prompt(setupMessageRef("guided.command-line-tools-prompt")),
    );
    if (answer.kind === "cancelled") return { code: 1 };
    if (!answer.value) {
      prompt.logWarn(presenter.text(setupMessageRef("guided.command-line-tools-declined")));
      return finishIncomplete(composition);
    }
    intent = { ...intent, installBootstrap: true };
    state = await composition.session.application.replaceIntent(intent);
    if (state.status !== "editing") return renderUnavailableState(composition, state);
    // The Command Line Tools prompt must settle before Apple's installer takes terminal ownership.
    await composition.session.application.prepare();
    return finishIncomplete(composition);
  }

  let facts = requireFacts(composition);
  if (facts.brew.status === "missing" && shouldOfferHomebrew(facts)) {
    const requiredForCoreTools = coreToolsNeedHomebrew(facts);
    const answer = await confirm(
      composition,
      presenter.prompt(setupMessageRef("guided.homebrew-prompt")),
    );
    if (answer.kind === "cancelled") return { code: 1 };
    if (!answer.value) {
      prompt.logWarn(homebrewDeclinedCallout(facts, presenter).trim());
    } else {
      intent = { ...intent, installBootstrap: true };
      state = await composition.session.application.replaceIntent(intent);
      if (state.status !== "editing") return renderUnavailableState(composition, state);
      const outcomesBeforePreparation = state.operationOutcomes.length;
      state = await composition.session.application.prepare();
      const homebrewFailed = state.operationOutcomes
        .slice(outcomesBeforePreparation)
        .some(
          (outcome) => outcome.operation.kind === "install-homebrew" && outcome.status === "failed",
        );
      if (homebrewFailed && requiredForCoreTools) {
        prompt.logError(presenter.text(setupMessageRef("guided.homebrew-manual")));
        return finishIncomplete(composition);
      }
      if (homebrewFailed) {
        prompt.logWarn(
          [
            presenter.text(setupMessageRef("guided.homebrew-failed")),
            presenter.text(setupMessageRef("guided.homebrew-continue")),
          ].join("\n"),
        );
      }
    }
  }

  projection = await currentProjection(composition);
  if (projection === undefined) return finishIncomplete(composition);
  const selectedToolOperations =
    projection.session.plan?.operations.filter(
      (operation): operation is Extract<SetupOperation, { kind: "install-tool" }> =>
        operation.kind === "install-tool" && operation.selected,
    ) ?? [];
  const missingTools = projection.session.plan?.issues.some(
    (issue) => issue.code === "tool-missing" && issue.tier === "required",
  );
  if (selectedToolOperations.length > 0) {
    renderRequiredToolsReview(composition, projection, selectedToolOperations);
    const answer = await confirm(
      composition,
      presenter.prompt(setupMessageRef("guided.tools-prompt")),
    );
    if (answer.kind === "cancelled") return { code: 1 };
    if (!answer.value) {
      prompt.logWarn(presenter.text(setupMessageRef("guided.no-changes")));
      return finishIncomplete(composition);
    }
    state = await composition.session.application.prepare();
    projection = await requireProjection(composition, state);
    if (projection === undefined) return finishIncomplete(composition);
    if (
      projection.session.plan?.issues.some(
        (issue) => issue.code === "tool-missing" && issue.tier === "required",
      )
    ) {
      await presenter.write(presenter.renderApplyResult(projection.view));
      return finishIncomplete(composition);
    }
  } else if (missingTools) {
    await presenter.write(presenter.renderApplyResult(projection.view));
    return finishIncomplete(composition);
  }

  facts = requireFacts(composition);
  if (!facts.harnesses.some((harness) => harness.status === "ok")) {
    prompt.logWarn(
      [
        presenter.text(setupMessageRef("guided.no-agent-title")),
        presenter.text(setupMessageRef("guided.no-agent-explanation")),
      ].join("\n"),
    );
    projection = await currentProjection(composition);
    if (projection === undefined) return finishIncomplete(composition);
    const installerChoices = installerPromptChoices(projection, presenter);
    let installHarnesses: SupportedHarnessId[] | undefined;
    while (installHarnesses === undefined) {
      const answer = await selectMany(composition, {
        message: installerSelectionMessage(presenter, installerChoices.length),
        choices: installerChoices,
      });
      if (answer.kind === "cancelled") return { code: 1 };
      const selected = validateSelectedValues(answer.value, installerChoices);
      if (selected === undefined) {
        prompt.logWarn(presenter.text(setupMessageRef("guided.invalid-selection")));
        continue;
      }
      installHarnesses = selected.flatMap((value) => (isSupportedHarnessId(value) ? [value] : []));
    }
    if (installHarnesses.length === 0) {
      prompt.logWarn(
        [
          presenter.text(setupMessageRef("guided.no-agent-installed")),
          presenter.text(setupMessageRef("guided.install-one-agent")),
          "stn setup",
        ].join("\n"),
      );
      return finishIncomplete(composition);
    }
    for (const harnessId of installHarnesses) {
      intent = { ...intent, installHarnesses: [harnessId] };
      state = await composition.session.application.replaceIntent(intent);
      if (state.status !== "editing") return renderUnavailableState(composition, state);
      state = await composition.session.application.prepare();
    }
    intent = { ...intent, installHarnesses: [] };
    state = await composition.session.application.replaceIntent(intent);
    if (state.status !== "editing") return renderUnavailableState(composition, state);
    facts = requireFacts(composition);
    const unavailable = installHarnesses.filter(
      (harnessId) =>
        !facts.harnesses.some((harness) => harness.id === harnessId && harness.status === "ok"),
    );
    if (unavailable.length > 0) {
      prompt.logWarn(
        [
          presenter.text(setupMessageRef("guided.agents-unavailable")),
          ...facts.harnesses.flatMap((harness) =>
            unavailable.includes(harness.id) ? [`- ${harness.label}`] : [],
          ),
        ].join("\n"),
      );
    }
    if (!facts.harnesses.some((harness) => harness.status === "ok")) {
      prompt.logError(
        [
          presenter.text(setupMessageRef("guided.no-agent-detected")),
          presenter.text(setupMessageRef("guided.agent-path-hint")),
          "stn setup",
        ].join("\n"),
      );
      return finishIncomplete(composition);
    }
  }

  facts = requireFacts(composition);
  projection = await currentProjection(composition);
  if (projection === undefined) return finishIncomplete(composition);
  if (configuredDefaultBlocksSelection(facts)) {
    await presenter.write(presenter.renderApplyResult(projection.view));
    return finishIncomplete(composition);
  }
  const harnessSelection = await selectHarnesses(facts, composition);
  if (harnessSelection.kind === "cancelled") return { code: 1 };
  if (harnessSelection.kind === "blocked") return finishIncomplete(composition);
  if (facts.config.status !== "invalid") {
    intent = {
      ...intent,
      harnessSelection: { kind: "explicit", harnessIds: harnessSelection.harnessIds },
    };
    state = await composition.session.application.replaceIntent(intent);
    projection = await requireProjection(composition, state);
    if (projection === undefined) return finishIncomplete(composition);
  }

  let linkStationLaunchers = false;
  if (shouldPromptLauncherLink(requireFacts(composition))) {
    const answer = await confirm(
      composition,
      presenter.prompt(setupMessageRef("guided.launcher-link-prompt")),
    );
    if (answer.kind === "cancelled") return { code: 1 };
    linkStationLaunchers = answer.value;
  }
  facts = requireFacts(composition);
  let installWorktrunkHooks = false;
  if (shouldPromptWorktrunkHooks(facts)) {
    const answer = await confirm(
      composition,
      presenter.prompt(setupMessageRef("guided.worktrunk-hooks-prompt")),
    );
    if (answer.kind === "cancelled") return { code: 1 };
    installWorktrunkHooks = answer.value;
  }

  intent = { ...intent, linkStationLaunchers, installWorktrunkHooks };
  state = await composition.session.application.replaceIntent(intent);
  projection = await requireProjection(composition, state);
  if (projection === undefined) return finishIncomplete(composition);

  const unavailableRequired = unavailableRequiredHarnesses(projection, requireFacts(composition));
  if (unavailableRequired.length > 0) {
    prompt.logError(
      presenter.text(
        setupMessageRef("guided.required-harnesses-unavailable", {
          harnesses: unavailableRequired.join(", "),
        }),
      ),
    );
    return finishIncomplete(composition);
  }
  if (
    projection.session.plan === undefined ||
    !assessSetupPlan(projection.session.plan).canContinueEditing
  ) {
    await presenter.write(presenter.renderApplyResult(projection.view));
    return finishIncomplete(composition);
  }

  const installHarnessTracking: SupportedHarnessId[] = [];
  for (const issue of projection.session.plan.issues) {
    if (issue.code !== "harness-tracking-unprepared" || issue.tier !== "required") continue;
    const label = presenter.text(
      setupMessageRef("action.harness-tracking-label", {
        harness: harnessLabel(requireFacts(composition), issue.harnessId),
      }),
    );
    const answer = await confirm(
      composition,
      presenter.prompt(setupMessageRef("guided.tracking-consent-prompt", { label })),
    );
    if (answer.kind === "cancelled") return { code: 1 };
    if (!answer.value) {
      prompt.logWarn(presenter.text(setupMessageRef("guided.tracking-declined")));
      return finishIncomplete(composition);
    }
    installHarnessTracking.push(issue.harnessId);
  }

  const writesConfig = projection.session.plan.operations.some(
    (operation) => operation.kind === "write-config" && operation.selected,
  );
  if (writesConfig) {
    const answer = await confirm(
      composition,
      presenter.prompt(setupMessageRef("guided.config-write-prompt")),
    );
    if (answer.kind === "cancelled") return { code: 1 };
    if (!answer.value) {
      prompt.logWarn(presenter.text(setupMessageRef("guided.config-not-written")));
      return finishIncomplete(composition);
    }
  }

  const shellOperation = projection.session.plan.operations.find(
    (operation) => operation.kind === "configure-worktrunk-shell",
  );
  const shellAction = projection.view.actions.find(
    (action) => action.operationId === shellOperation?.id,
  );
  let installWorktrunkShell = false;
  if (shellAction !== undefined) {
    const answer = await confirm(
      composition,
      presenter.prompt(setupMessageRef("guided.worktrunk-shell-prompt")),
    );
    if (answer.kind === "cancelled") return { code: 1 };
    installWorktrunkShell = answer.value;
  }
  const tmuxOperation = projection.session.plan.operations.find(
    (operation) => operation.kind === "configure-tmux-popup",
  );
  let configureTmuxPopup = false;
  if (tmuxOperation !== undefined) {
    const answer = await confirm(
      composition,
      presenter.prompt(setupMessageRef("guided.tmux-popup-prompt")),
    );
    if (answer.kind === "cancelled") return { code: 1 };
    configureTmuxPopup = answer.value;
  }

  intent = {
    ...intent,
    harnessTrackingSelection: { kind: "explicit", harnessIds: installHarnessTracking },
    installWorktrunkShell,
    configureTmuxPopup,
  };
  state = await composition.session.application.replaceIntent(intent);
  projection = await requireProjection(composition, state);
  if (projection === undefined) return finishIncomplete(composition);
  if (projection.session.plan === undefined || !assessSetupPlan(projection.session.plan).canApply) {
    await presenter.write(presenter.renderApplyResult(projection.view));
    return finishIncomplete(composition);
  }

  state = await composition.session.application.review();
  projection = await requireProjection(composition, state);
  if (projection === undefined) return finishIncomplete(composition);
  renderSelectedChangesReview(composition, projection);

  state = await composition.session.application.apply();
  projection = await requireProjection(composition, state);
  if (projection === undefined) return finishIncomplete(composition);
  const finalView = overlaySetupOperationOutcomes(
    projection.view,
    projection.session.operationOutcomes,
  );
  if (
    projection.session.operationOutcomes.some(
      (outcome) =>
        outcome.status === "failed" &&
        (outcome.operation.kind === "prepare-harness-tracking" ||
          outcome.operation.kind === "prepare-worktrunk-tracking"),
    )
  ) {
    prompt.logWarn(presenter.text(setupMessageRef("guided.hook-install-failed")));
  }
  renderTmuxFeedback(composition, configureTmuxPopup);
  await presenter.write(presenter.renderApplyResult(finalView));
  const successful = state.status === "completed" && state.result.readiness.workflowReady;
  if (successful) {
    prompt.outro(presenter.text(setupMessageRef("guided.complete-outro")));
    return { code: 0 };
  }
  return finishIncomplete(composition);
}

function guidedIntent(): SetupEditableIntent {
  return {
    harnessSelection: { kind: "automatic" },
    installBootstrap: false,
    installHarnesses: [],
    linkStationLaunchers: false,
    harnessTrackingSelection: { kind: "explicit", harnessIds: [] },
    installWorktrunkHooks: false,
    installWorktrunkShell: false,
    configureTmuxPopup: false,
  };
}

async function selectHarnesses(
  facts: SetupFacts,
  composition: SetupComposition,
): Promise<GuidedHarnessSelection> {
  const available = facts.harnesses.filter((harness) => harness.status === "ok");
  if (available.length === 0) return { kind: "blocked" };
  if (facts.config.status === "invalid" || available.length === 1) {
    const only = available[0];
    return only === undefined ? { kind: "blocked" } : { kind: "selected", harnessIds: [only.id] };
  }
  const presenter = composition.text;
  const configuredDefault =
    facts.config.status === "valid" ? facts.config.defaults.harness : undefined;
  const ordered = [...available].sort((left, right) => {
    if (left.id === configuredDefault) return -1;
    if (right.id === configuredDefault) return 1;
    return 0;
  });
  const choices = ordered.map((harness) => {
    const choice: SetupPromptChoice = { value: harness.id, label: harness.label };
    if (harness.id === configuredDefault) {
      choice.hint = presenter.text(setupMessageRef("guided.current-default-hint"));
    } else if (harness.version !== undefined) {
      choice.hint = harness.version;
    }
    return choice;
  });
  const initialValues = configuredDefault === undefined ? undefined : [configuredDefault];
  let selected: string[] | undefined;
  while (selected === undefined || selected.length === 0) {
    const message = harnessSelectionMessage(presenter, choices.length);
    const request: Parameters<SetupPromptAdapter["selectMany"]>[0] =
      initialValues === undefined ? { message, choices } : { message, choices, initialValues };
    const answer = await selectMany(composition, request);
    if (answer.kind === "cancelled") return { kind: "cancelled" };
    selected = validateSelectedValues(answer.value, choices);
    if (selected === undefined) {
      composition.guided.logWarn(presenter.text(setupMessageRef("guided.invalid-selection")));
    } else if (selected.length === 0) {
      composition.guided.logWarn(presenter.text(setupMessageRef("guided.harness-select-required")));
    }
  }
  const selectedHarnesses = selected.flatMap((value) =>
    isSupportedHarnessId(value) ? [value] : [],
  );
  if (facts.config.status !== "missing" || selectedHarnesses.length < 2) {
    return { kind: "selected", harnessIds: selectedHarnesses };
  }
  const defaultChoices = choices.filter((choice) => selected.includes(choice.value));
  const initialValue = selected[0];
  if (initialValue === undefined) return { kind: "blocked" };
  while (true) {
    const answer = await selectOne(composition, {
      message: presenter.prompt(setupMessageRef("guided.default-agent-prompt")),
      choices: defaultChoices,
      initialValue,
    });
    if (answer.kind === "cancelled") return { kind: "cancelled" };
    if (!selected.includes(answer.value)) {
      composition.guided.logWarn(presenter.text(setupMessageRef("guided.invalid-selection")));
      continue;
    }
    const defaultHarness = answer.value as SupportedHarnessId;
    return {
      kind: "selected",
      harnessIds: [defaultHarness, ...selectedHarnesses.filter((id) => id !== defaultHarness)],
    };
  }
}

function configuredDefaultBlocksSelection(facts: SetupFacts): boolean {
  if (facts.config.status !== "valid") return facts.config.status === "invalid";
  const configuredDefault = facts.config.defaults.harness;
  return (
    !isSupportedHarnessId(configuredDefault) ||
    !facts.harnesses.some((harness) => harness.id === configuredDefault && harness.status === "ok")
  );
}

function installerPromptChoices(
  projection: Extract<SetupSessionProjection, { status: "projected" }>,
  presenter: TextSetupPresenter,
): SetupPromptChoice[] {
  const choices =
    projection.session.plan?.operations.flatMap((operation) => {
      if (operation.kind !== "install-harness") return [];
      const action = projection.view.actions.find(
        (candidate) => candidate.operationId === operation.id,
      );
      if (action === undefined) return [];
      return [
        {
          value: operation.harnessId,
          label: presenter.text(action.label),
          hint: presenter.text(action.explanation),
        },
      ];
    }) ?? [];
  const displayOrder = ["claude", "codex", "cursor", "opencode", "pi"];
  return choices.sort(
    (...choicePair) =>
      displayOrder.indexOf(choicePair[0].value) - displayOrder.indexOf(choicePair[1].value),
  );
}

function validateSelectedValues(
  values: readonly string[],
  choices: readonly SetupPromptChoice[],
): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const allowed = new Set(choices.map((choice) => choice.value));
  const selected: string[] = [];
  for (const value of values) {
    if (!allowed.has(value) || selected.includes(value)) return undefined;
    selected.push(value);
  }
  return selected;
}

function harnessSelectionMessage(presenter: TextSetupPresenter, count: number): string {
  return [
    presenter.prompt(setupMessageRef("guided.harness-select-prompt")),
    presenter.text(setupMessageRef("guided.selection-summary", { count })),
    presenter.text(setupMessageRef("guided.selection-instructions")),
  ].join("\n");
}

function installerSelectionMessage(presenter: TextSetupPresenter, count: number): string {
  return [
    presenter.prompt(setupMessageRef("guided.installer-select-prompt", { count })),
    presenter.text(setupMessageRef("guided.selection-instructions")),
  ].join("\n");
}

function unavailableRequiredHarnesses(
  projection: Extract<SetupSessionProjection, { status: "projected" }>,
  facts: SetupFacts,
): SupportedHarnessId[] {
  const plan = projection.session.plan;
  if (plan?.selection.outcome !== "selected") return [];
  return plan.selection.requiredHarnessIds.filter(
    (harnessId) =>
      !facts.harnesses.some((harness) => harness.id === harnessId && harness.status === "ok"),
  );
}

function coreToolsNeedHomebrew(facts: SetupFacts): boolean {
  return (
    facts.worktrunk.status !== "ok" ||
    facts.tmux.status !== "ok" ||
    facts.bun.status !== "ok" ||
    facts.diffnav.status !== "ok" ||
    facts.gitDelta.status !== "ok"
  );
}

function shouldOfferHomebrew(facts: SetupFacts): boolean {
  return (
    coreToolsNeedHomebrew(facts) ||
    (facts.xcode.applicable && !facts.harnesses.some((harness) => harness.status === "ok"))
  );
}

function homebrewDeclinedCallout(facts: SetupFacts, presenter: TextSetupPresenter): string {
  if (!coreToolsNeedHomebrew(facts)) {
    return presenter.text(setupMessageRef("guided.homebrew-agents-only"));
  }
  const lines = [
    presenter.text(setupMessageRef("guided.homebrew-core-required")),
    presenter.text(setupMessageRef("guided.homebrew-url")),
  ];
  if (facts.xcode.applicable) {
    lines.push(presenter.text(setupMessageRef("guided.command-line-tools-hint")));
  }
  return lines.join("\n");
}

function shouldPromptLauncherLink(facts: SetupFacts): boolean {
  return [facts.launchers.station, facts.launchers.ingress, facts.launchers.tmuxPopup].some(
    (launcher) => launcher.source === "checkout",
  );
}

function shouldPromptWorktrunkHooks(facts: SetupFacts): boolean {
  return (
    facts.worktrunk.status === "ok" &&
    (facts.config.status === "missing" ||
      (facts.config.status === "valid" && facts.config.worktrunkUseLifecycleHooks === true))
  );
}

async function renderOperationStarted(
  composition: SetupComposition,
  operation: SetupOperation,
): Promise<void> {
  const label = operationLabel(composition, operation);
  if (operation.kind === "activate-observer-config") {
    composition.guided.logStep(composition.text.renderActivationStart());
    return;
  }
  if (externalOutputOperation(operation)) {
    composition.guided.logStep(
      composition.text.text(setupMessageRef("guided.external-start", { label })),
    );
    return;
  }
  composition.guided.logStep(label);
}

async function renderOperationFinished(
  composition: SetupComposition,
  operation: SetupOperation,
  outcome: SetupOperationOutcome,
): Promise<void> {
  const presenter = composition.text;
  const label = operationLabel(composition, operation);
  if (operation.kind === "activate-observer-config" && outcome.status === "completed") {
    composition.guided.logSuccess(presenter.renderActivationComplete());
  } else if (externalOutputOperation(operation)) {
    if (outcome.status === "completed") {
      composition.guided.logSuccess(
        presenter.text(setupMessageRef("guided.external-success", { label })),
      );
    } else {
      composition.guided.logError(
        `${presenter.text(setupMessageRef("guided.external-failure", { label }))}\n${safeErrorText(outcome.error)}`,
      );
    }
  } else if (outcome.status === "completed") {
    composition.guided.logSuccess(label);
  } else {
    composition.guided.logError(`${label}\n${safeErrorText(outcome.error)}`);
  }

  if (operation.kind === "activate-observer-config" && outcome.status === "failed") {
    const configPath =
      composition.session.snapshot()?.facts.configPath ?? "~/.config/station/config.toml";
    await presenter.write(
      presenter.renderActivationFailure(outcome.error, {
        restart: ["stn", "--config", configPath, "observer", "restart"],
        setup: ["stn", "--config", configPath, "setup", "apply", "--yes"],
      }),
    );
  }
  if (operation.kind === "install-xcode-command-line-tools") {
    composition.guided.logInfo(
      presenter.text(
        setupMessageRef(
          outcome.status === "completed"
            ? "guided.command-line-tools-started"
            : "guided.command-line-tools-failed",
        ),
      ),
    );
  }
  if (operation.kind === "link-launchers" && outcome.status === "failed") {
    composition.guided.logWarn(presenter.text(setupMessageRef("guided.launcher-link-failed")));
  }
  if (operation.kind === "configure-worktrunk-shell" && outcome.status === "failed") {
    composition.guided.logWarn(presenter.text(setupMessageRef("guided.worktrunk-shell-missing")));
  }
}

// Child-owned installers must run only after the Clack prompt has settled, with no concurrent spinner or prompt reader.
function externalOutputOperation(operation: SetupOperation): boolean {
  return (
    operation.kind === "install-homebrew" ||
    operation.kind === "install-tool" ||
    operation.kind === "install-harness" ||
    operation.kind === "link-launchers" ||
    operation.kind === "configure-worktrunk-shell"
  );
}

function safeErrorText(error: SafeError): string {
  return [
    `${error.message} (${error.code})`,
    ...(error.hint === undefined ? [] : [`Recovery: ${error.hint}`]),
  ].join("\n");
}

function operationLabel(composition: SetupComposition, operation: SetupOperation): string {
  const projection = composition.project(composition.session.application.getState());
  if (projection.status === "projected") {
    const matching = projection.view.actions.filter(
      (candidate) => candidate.operationId === operation.id,
    );
    const action = matching.find((candidate) => candidate.kind === operation.kind) ?? matching[0];
    if (action !== undefined) return composition.text.text(action.label);
  }
  switch (operation.kind) {
    case "activate-observer-config":
      return composition.text.text(setupMessageRef("label.observer-activation"));
    case "install-homebrew":
      return composition.text.text(
        setupMessageRef("action.install-label", {
          label: composition.text.text(setupMessageRef("label.homebrew")),
        }),
      );
    case "install-xcode-command-line-tools":
      return composition.text.text(
        setupMessageRef("action.install-label", {
          label: composition.text.text(setupMessageRef("label.command-line-tools")),
        }),
      );
    case "install-harness":
      return composition.text.text(
        setupMessageRef("action.install-label", {
          label: harnessLabel(composition.session.snapshot()?.facts, operation.harnessId),
        }),
      );
    default:
      return composition.text.text(setupMessageRef("label.setup-operation"));
  }
}

function harnessLabel(facts: SetupFacts | undefined, harnessId: SupportedHarnessId): string {
  return facts?.harnesses.find((harness) => harness.id === harnessId)?.label ?? harnessId;
}

function renderTmuxFeedback(composition: SetupComposition, requested: boolean): void {
  const facts = composition.session.snapshot()?.facts;
  if (facts === undefined || (!requested && facts.tmuxBinding.status !== "ok")) return;
  const presenter = composition.text;
  const popupCommand = formatCommand([facts.launchers.station.command, "popup"]);
  if (facts.tmuxBinding.status === "ok") {
    composition.guided.logInfo(
      presenter.text(
        setupMessageRef(
          facts.tmuxBinding.liveStatus === "loaded" ? "guided.tmux-loaded" : "guided.tmux-future",
          { key: facts.tmuxBinding.bindingKey },
        ),
      ),
    );
  } else if (requested) {
    composition.guided.logWarn(presenter.text(setupMessageRef("guided.tmux-not-persisted")));
  }
  composition.guided.logInfo(
    presenter.text(setupMessageRef("guided.direct-fallback", { command: popupCommand })),
  );
}

function renderRequiredToolsReview(
  composition: SetupComposition,
  projection: Extract<SetupSessionProjection, { status: "projected" }>,
  operations: readonly Extract<SetupOperation, { kind: "install-tool" }>[],
): void {
  const presenter = composition.text;
  const actionsByOperationId = new Map(
    projection.view.actions.flatMap((action) =>
      action.operationId === undefined ? [] : [[action.operationId, action] as const],
    ),
  );
  const proposedChanges = operations.map((operation) => {
    const action = actionsByOperationId.get(operation.id);
    const description =
      action === undefined
        ? operationLabel(composition, operation)
        : presenter.text(action.explanation);
    return `- ${description}`;
  });
  const body = [
    presenter.text(setupMessageRef("guided.required-tools-intro")),
    ...proposedChanges,
  ].join("\n");
  composition.guided.note(body, presenter.text(setupMessageRef("guided.required-tools-title")));
}

function renderSelectedChangesReview(
  composition: SetupComposition,
  projection: Extract<SetupSessionProjection, { status: "projected" }>,
): void {
  const presenter = composition.text;
  const completedIds = new Set(
    projection.session.operationOutcomes.flatMap((outcome) =>
      outcome.status === "completed" ? [outcome.operation.id] : [],
    ),
  );
  const completed = projection.session.operationOutcomes.flatMap((outcome) =>
    outcome.status === "completed" ? [operationLabel(composition, outcome.operation)] : [],
  );
  const representedOperationIds = new Set(
    projection.view.actions.flatMap((action) =>
      action.operationId === undefined ? [] : [action.operationId],
    ),
  );
  const pending = [
    ...projection.view.actions.flatMap((action) =>
      action.selected && (action.operationId === undefined || !completedIds.has(action.operationId))
        ? [presenter.text(action.label)]
        : [],
    ),
    ...(projection.session.plan?.operations.flatMap((operation) =>
      operation.selected &&
      !completedIds.has(operation.id) &&
      !representedOperationIds.has(operation.id)
        ? [operationLabel(composition, operation)]
        : [],
    ) ?? []),
  ];
  const none = presenter.text(setupMessageRef("guided.review-none"));
  const body = [
    presenter.text(setupMessageRef("guided.review-completed")),
    ...(completed.length === 0 ? [none] : completed.map((label) => `- ${label}`)),
    "",
    presenter.text(setupMessageRef("guided.review-apply")),
    ...(pending.length === 0 ? [none] : pending.map((label) => `- ${label}`)),
  ].join("\n");
  composition.guided.note(body, presenter.text(setupMessageRef("guided.review-title")));
}

async function confirm(
  composition: SetupComposition,
  message: string,
): Promise<GuidedPromptResult<boolean>> {
  return normalizePromptAnswer(composition, await composition.guided.confirm({ message }));
}

async function selectOne(
  composition: SetupComposition,
  request: Parameters<SetupPromptAdapter["selectOne"]>[0],
): Promise<GuidedPromptResult<string>> {
  return normalizePromptAnswer(composition, await composition.guided.selectOne(request));
}

async function selectMany(
  composition: SetupComposition,
  request: Parameters<SetupPromptAdapter["selectMany"]>[0],
): Promise<GuidedPromptResult<readonly string[]>> {
  return normalizePromptAnswer(composition, await composition.guided.selectMany(request));
}

async function normalizePromptAnswer<T>(
  composition: SetupComposition,
  answer: SetupPromptAnswer<T>,
): Promise<GuidedPromptResult<T>> {
  if (answer.kind === "answered") return answer;
  await composition.session.application.cancel();
  composition.guided.cancel(composition.text.text(setupMessageRef("guided.cancelled")));
  return { kind: "cancelled" };
}

async function renderInteractiveTerminalRequirement(composition: SetupComposition): Promise<void> {
  await composition.text.write(
    [
      composition.text.text(setupMessageRef("guided.interactive-required")),
      composition.text.text(setupMessageRef("guided.interactive-recovery")),
      composition.text.text(setupMessageRef("guided.interactive-automation")),
      "",
    ].join("\n"),
  );
}

function finishIncomplete(composition: SetupComposition): SetupCommandResult {
  composition.guided.outro(composition.text.text(setupMessageRef("guided.incomplete-outro")));
  return { code: 1 };
}

async function currentProjection(
  composition: SetupComposition,
): Promise<Extract<SetupSessionProjection, { status: "projected" }> | undefined> {
  return requireProjection(composition, composition.session.application.getState());
}

async function requireProjection(
  composition: SetupComposition,
  state: SetupSessionState,
): Promise<Extract<SetupSessionProjection, { status: "projected" }> | undefined> {
  const projection = composition.project(state);
  if (projection.status === "projected") return projection;
  await composition.text.write(`${composition.text.renderInspectionFailure(projection.error)}\n`);
  return undefined;
}

async function renderUnavailableState(
  composition: SetupComposition,
  state: SetupSessionState,
): Promise<SetupCommandResult> {
  await requireProjection(composition, state);
  return finishIncomplete(composition);
}

function requireFacts(composition: SetupComposition): SetupFacts {
  const facts = composition.session.snapshot()?.facts;
  if (facts === undefined) throw new Error("Guided setup requires current inspected CLI facts.");
  return facts;
}

function requireComposition(composition: SetupComposition | undefined): SetupComposition {
  if (composition === undefined) throw new Error("Guided setup composition is unavailable.");
  return composition;
}
