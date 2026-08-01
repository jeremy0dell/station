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
import { createLinePromptSetupPresenter } from "../presenters/linePrompt.js";
import type { TextSetupPresenter } from "../presenters/text.js";
import { formatCommand } from "../render.js";
import type {
  SetupCommandDeps,
  SetupCommandOptions,
  SetupCommandResult,
  SetupPromptAdapter,
} from "../types.js";

type CreateGuidedSetupComposition = (
  options: SetupCommandOptions,
  progress: SetupOperationProgress,
  initialIntent: SetupEditableIntent,
) => SetupComposition;

/**
 * ADAPTER
 *
 * Drives guided line-oriented setup through one injected composition while keeping prompts, progress, and terminal ownership outside setup core.
 */
export async function runGuidedSetupSession(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  createComposition: CreateGuidedSetupComposition,
): Promise<SetupCommandResult> {
  const prompt = deps.prompt ?? createLinePromptSetupPresenter();
  const initialIntent = guidedIntent();
  let composition: SetupComposition | undefined;
  try {
    composition = createComposition(
      options,
      {
        started: (operation) => renderOperationStarted(requireComposition(composition), operation),
        finished: (operation, outcome) =>
          renderOperationFinished(requireComposition(composition), operation, outcome),
      },
      initialIntent,
    );
    return await driveGuidedSession(composition, prompt, initialIntent);
  } finally {
    await prompt.close?.();
  }
}

async function driveGuidedSession(
  composition: SetupComposition,
  prompt: SetupPromptAdapter,
  initialIntent: SetupEditableIntent,
): Promise<SetupCommandResult> {
  const presenter = composition.text;
  let intent = initialIntent;

  await presenter.writeMessage(setupMessageRef("setup.introduction"));
  await presenter.write("\n");

  let state = await composition.session.application.start();
  let projection = await requireProjection(composition, state);
  if (projection === undefined) return { code: 1 };
  const initialPlan = projection.session.plan;
  if (initialPlan === undefined || !assessSetupPlan(initialPlan).canPrepare) {
    await presenter.write(presenter.renderApplyResult(projection.view));
    return { code: 1 };
  }

  const commandLineTools = composition.session.snapshot()?.facts.xcode.status === "missing";
  if (commandLineTools) {
    const accepted = await prompt.confirm(
      presenter.prompt(setupMessageRef("guided.command-line-tools-prompt")),
    );
    if (!accepted) {
      await presenter.writeMessage(setupMessageRef("guided.command-line-tools-declined"));
      return { code: 1 };
    }
    intent = { ...intent, installBootstrap: true };
    state = await composition.session.application.replaceIntent(intent);
    if (state.status !== "editing") return renderUnavailableState(composition, state);
    await withPromptPaused(prompt, () => composition.session.application.prepare());
    return { code: 1 };
  }

  let facts = requireFacts(composition);
  if (facts.brew.status === "missing" && shouldOfferHomebrew(facts)) {
    const requiredForCoreTools = coreToolsNeedHomebrew(facts);
    const accepted = await prompt.confirm(
      presenter.prompt(setupMessageRef("guided.homebrew-prompt")),
    );
    if (!accepted) {
      await presenter.write(homebrewDeclinedCallout(facts, presenter));
    } else {
      intent = { ...intent, installBootstrap: true };
      state = await composition.session.application.replaceIntent(intent);
      if (state.status !== "editing") return renderUnavailableState(composition, state);
      const before = state.operationOutcomes.length;
      state = await withPromptPaused(prompt, () => composition.session.application.prepare());
      const homebrewFailed = state.operationOutcomes
        .slice(before)
        .some(
          (outcome) => outcome.operation.kind === "install-homebrew" && outcome.status === "failed",
        );
      if (homebrewFailed && requiredForCoreTools) {
        await presenter.writeMessage(setupMessageRef("guided.homebrew-manual"));
        return { code: 1 };
      }
      if (homebrewFailed) {
        await presenter.writeMessage(setupMessageRef("guided.homebrew-continue"));
      }
    }
  }

  projection = await currentProjection(composition);
  if (projection === undefined) return { code: 1 };
  const selectedToolOperations =
    projection.session.plan?.operations.filter(
      (operation) => operation.kind === "install-tool" && operation.selected,
    ) ?? [];
  const missingTools = projection.session.plan?.issues.some(
    (issue) => issue.code === "tool-missing" && issue.tier === "required",
  );
  if (selectedToolOperations.length > 0) {
    await presenter.write(presenter.renderPlan(projection.view));
    if (!(await prompt.confirm(presenter.prompt(setupMessageRef("guided.tools-prompt"))))) {
      await presenter.writeMessage(setupMessageRef("guided.no-changes"));
      return { code: 1 };
    }
    state = await withPromptPaused(prompt, () => composition.session.application.prepare());
    projection = await requireProjection(composition, state);
    if (projection === undefined) return { code: 1 };
    if (
      projection.session.plan?.issues.some(
        (issue) => issue.code === "tool-missing" && issue.tier === "required",
      )
    ) {
      await presenter.write(presenter.renderPlan(projection.view));
      return { code: 1 };
    }
  } else if (missingTools) {
    await presenter.write(presenter.renderPlan(projection.view));
    return { code: 1 };
  }

  facts = requireFacts(composition);
  if (!facts.harnesses.some((harness) => harness.status === "ok")) {
    await presenter.write(
      [
        "",
        presenter.text(setupMessageRef("guided.no-agent-title")),
        presenter.text(setupMessageRef("guided.no-agent-explanation")),
        "",
      ].join("\n"),
    );
    const installHarnesses: SupportedHarnessId[] = [];
    projection = await currentProjection(composition);
    if (projection === undefined) return { code: 1 };
    for (const operation of projection.session.plan?.operations ?? []) {
      if (operation.kind !== "install-harness") continue;
      const action = projection.view.actions.find(
        (candidate) => candidate.operationId === operation.id,
      );
      if (action === undefined) continue;
      const accepted = await prompt.confirm(
        presenter.prompt(
          setupMessageRef("guided.installer-prompt", {
            label: presenter.text(action.label),
            description: presenter.text(action.explanation),
          }),
        ),
      );
      if (accepted) installHarnesses.push(operation.harnessId);
    }
    if (installHarnesses.length === 0) {
      await presenter.write(
        [
          presenter.text(setupMessageRef("guided.no-agent-installed")),
          presenter.text(setupMessageRef("guided.install-one-agent")),
          "  stn setup",
          "",
        ].join("\n"),
      );
      return { code: 1 };
    }
    intent = { ...intent, installHarnesses };
    state = await composition.session.application.replaceIntent(intent);
    if (state.status !== "editing") return renderUnavailableState(composition, state);
    state = await withPromptPaused(prompt, () => composition.session.application.prepare());
    facts = requireFacts(composition);
    const unavailable = installHarnesses.filter(
      (harnessId) =>
        !facts.harnesses.some((harness) => harness.id === harnessId && harness.status === "ok"),
    );
    if (unavailable.length > 0) {
      await presenter.write(
        [
          presenter.text(setupMessageRef("guided.agents-unavailable")),
          ...facts.harnesses.flatMap((harness) =>
            unavailable.includes(harness.id) ? [`  - ${harness.label}`] : [],
          ),
          "",
        ].join("\n"),
      );
    }
    if (!facts.harnesses.some((harness) => harness.status === "ok")) {
      await presenter.write(
        [
          presenter.text(setupMessageRef("guided.no-agent-detected")),
          presenter.text(setupMessageRef("guided.agent-path-hint")),
          "  stn setup",
          "",
        ].join("\n"),
      );
      return { code: 1 };
    }
  }

  facts = requireFacts(composition);
  const selectedHarnessIds = await selectHarnesses(facts, prompt, presenter);
  if (selectedHarnessIds === undefined) return { code: 1 };
  if (facts.config.status !== "invalid") {
    intent = {
      ...intent,
      harnessSelection: { kind: "explicit", harnessIds: selectedHarnessIds },
    };
    state = await composition.session.application.replaceIntent(intent);
    projection = await requireProjection(composition, state);
    if (projection === undefined) return { code: 1 };
  }

  const linkStationLaunchers = shouldPromptLauncherLink(requireFacts(composition))
    ? await prompt.confirm(presenter.prompt(setupMessageRef("guided.launcher-link-prompt")))
    : false;
  facts = requireFacts(composition);
  const installWorktrunkHooks = shouldPromptWorktrunkHooks(facts)
    ? await prompt.confirm(presenter.prompt(setupMessageRef("guided.worktrunk-hooks-prompt")))
    : false;

  intent = { ...intent, linkStationLaunchers, installWorktrunkHooks };
  state = await composition.session.application.replaceIntent(intent);
  projection = await requireProjection(composition, state);
  if (projection === undefined) return { code: 1 };

  const unavailableRequired = unavailableRequiredHarnesses(projection, requireFacts(composition));
  if (unavailableRequired.length > 0) {
    await presenter.writeMessage(
      setupMessageRef("guided.required-harnesses-unavailable", {
        harnesses: unavailableRequired.join(", "),
      }),
    );
    return { code: 1 };
  }
  if (
    projection.session.plan === undefined ||
    !assessSetupPlan(projection.session.plan).canContinueEditing
  ) {
    await presenter.write(presenter.renderApplyResult(projection.view));
    return { code: 1 };
  }

  const installHarnessTracking: SupportedHarnessId[] = [];
  for (const issue of projection.session.plan?.issues ?? []) {
    if (issue.code !== "harness-tracking-unprepared" || issue.tier !== "required") continue;
    const label = presenter.text(
      setupMessageRef("action.harness-tracking-label", {
        harness: harnessLabel(requireFacts(composition), issue.harnessId),
      }),
    );
    const accepted = await prompt.confirm(
      presenter.prompt(setupMessageRef("guided.tracking-consent-prompt", { label })),
    );
    if (!accepted) {
      await presenter.writeMessage(setupMessageRef("guided.tracking-declined"));
      return { code: 1 };
    }
    installHarnessTracking.push(issue.harnessId);
  }

  const writesConfig = projection.session.plan?.operations.some(
    (operation) => operation.kind === "write-config" && operation.selected,
  );
  if (
    writesConfig === true &&
    !(await prompt.confirm(presenter.prompt(setupMessageRef("guided.config-write-prompt"))))
  ) {
    await presenter.writeMessage(setupMessageRef("guided.config-not-written"));
    return { code: 1 };
  }

  const shellOperation = projection.session.plan?.operations.find(
    (operation) => operation.kind === "configure-worktrunk-shell",
  );
  const shellAction = projection.view.actions.find(
    (action) => action.operationId === shellOperation?.id,
  );
  const installWorktrunkShell =
    shellAction !== undefined &&
    (await prompt.confirm(presenter.prompt(setupMessageRef("guided.worktrunk-shell-prompt"))));
  const tmuxOperation = projection.session.plan?.operations.find(
    (operation) => operation.kind === "configure-tmux-popup",
  );
  const configureTmuxPopup =
    tmuxOperation !== undefined &&
    (await prompt.confirm(presenter.prompt(setupMessageRef("guided.tmux-popup-prompt"))));

  intent = {
    ...intent,
    harnessTrackingSelection: { kind: "explicit", harnessIds: installHarnessTracking },
    installWorktrunkShell,
    configureTmuxPopup,
  };
  state = await composition.session.application.replaceIntent(intent);
  projection = await requireProjection(composition, state);
  if (projection === undefined) return { code: 1 };
  if (projection.session.plan === undefined || !assessSetupPlan(projection.session.plan).canApply) {
    await presenter.write(presenter.renderApplyResult(projection.view));
    return { code: 1 };
  }

  state = await withPromptPaused(prompt, () => composition.session.application.apply());
  projection = await requireProjection(composition, state);
  if (projection === undefined) return { code: 1 };
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
    await presenter.writeMessage(setupMessageRef("guided.hook-install-failed"));
  }
  await renderTmuxFeedback(composition, configureTmuxPopup);
  await presenter.write(presenter.renderApplyResult(finalView));
  return {
    code: state.status === "completed" && state.result.readiness.workflowReady ? 0 : 1,
  };
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
  prompt: SetupPromptAdapter,
  presenter: TextSetupPresenter,
): Promise<SupportedHarnessId[] | undefined> {
  const available = facts.harnesses.filter((harness) => harness.status === "ok");
  if (available.length === 0) return undefined;
  if (facts.config.status === "invalid" || available.length === 1) {
    const only = available[0];
    return only === undefined ? undefined : [only.id];
  }
  const configuredDefault =
    facts.config.status === "valid" ? facts.config.defaults.harness : undefined;
  const ordered = [...available].sort((left, right) => {
    if (left.id === configuredDefault) return -1;
    if (right.id === configuredDefault) return 1;
    return 0;
  });
  const choices = ordered.map((harness) => ({ value: harness.id, label: harness.label }));
  while (true) {
    const selected = (
      await prompt.selectMany(
        presenter.prompt(setupMessageRef("guided.harness-select-prompt")),
        choices,
      )
    ).filter(isSupportedHarnessId);
    if (selected.length > 0) return selected;
    await presenter.writeMessage(setupMessageRef("guided.harness-select-required"));
  }
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
    return `${presenter.text(setupMessageRef("guided.homebrew-agents-only"))}\n\n`;
  }
  const lines = [
    presenter.text(setupMessageRef("guided.homebrew-core-required")),
    `  ${presenter.text(setupMessageRef("guided.homebrew-url"))}`,
  ];
  if (facts.xcode.applicable) {
    lines.push(`  ${presenter.text(setupMessageRef("guided.command-line-tools-hint"))}`);
  }
  return `${lines.join("\n")}\n\n`;
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
  const presenter = composition.text;
  const facts = composition.session.snapshot()?.facts;
  if (operation.kind === "write-config") return;
  if (operation.kind === "activate-observer-config") {
    await presenter.write(`${presenter.renderActivationStart()}\n`);
    return;
  }
  if (operation.kind === "install-homebrew") {
    await presenter.write(
      `\n${presenter.text(setupMessageRef("guided.homebrew-installing"))}\n${presenter.text(
        setupMessageRef("guided.external-output"),
      )}\n\n`,
    );
    return;
  }
  if (operation.kind === "install-harness") {
    const label = harnessLabel(facts, operation.harnessId);
    await presenter.write(
      `\n${presenter.text(setupMessageRef("guided.installing-agent", { label }))}\n${presenter.text(
        setupMessageRef("guided.external-output"),
      )}\n\n`,
    );
    return;
  }
  await presenter.write(
    `${presenter.renderProgressStart({ label: operationLabel(composition, operation) })}\n`,
  );
}

async function renderOperationFinished(
  composition: SetupComposition,
  operation: SetupOperation,
  outcome: SetupOperationOutcome,
): Promise<void> {
  const presenter = composition.text;
  const facts = composition.session.snapshot()?.facts;
  if (operation.kind === "activate-observer-config") {
    if (outcome.status === "completed") {
      await presenter.write(`${presenter.renderActivationComplete()}\n`);
      return;
    }
    const configPath = facts?.configPath ?? "~/.config/station/config.toml";
    await presenter.write(
      presenter.renderActivationFailure(outcome.error, {
        restart: ["stn", "--config", configPath, "observer", "restart"],
        setup: ["stn", "--config", configPath, "setup", "apply", "--yes"],
      }),
    );
    return;
  }
  if (operation.kind === "install-homebrew") {
    await presenter.write(
      `\n${presenter.text(
        setupMessageRef(
          outcome.status === "completed" ? "guided.homebrew-complete" : "guided.homebrew-failed",
        ),
      )}\n`,
    );
    return;
  }
  if (operation.kind === "install-harness") {
    const label = harnessLabel(facts, operation.harnessId);
    await presenter.write(
      `\n${presenter.text(
        setupMessageRef(
          outcome.status === "completed"
            ? "guided.agent-install-complete"
            : "guided.agent-install-failed",
          { label },
        ),
      )}\n`,
    );
    return;
  }
  if (operation.kind === "install-xcode-command-line-tools") {
    if (outcome.status === "failed") {
      await presenter.write(
        `${presenter.renderProgressFailure(
          { label: operationLabel(composition, operation) },
          outcome.error,
        )}\n`,
      );
    }
    await presenter.writeMessage(
      setupMessageRef(
        outcome.status === "completed"
          ? "guided.command-line-tools-started"
          : "guided.command-line-tools-failed",
      ),
    );
    return;
  }
  if (operation.kind === "configure-worktrunk-shell" && outcome.status === "failed") {
    await presenter.write(
      `${presenter.text(setupMessageRef("guided.worktrunk-shell-missing"))}\n${outcome.error.message}\n${
        outcome.error.hint ?? ""
      }\n`,
    );
    return;
  }
  const label = operationLabel(composition, operation);
  await presenter.write(
    `${
      outcome.status === "completed"
        ? presenter.renderProgressComplete({ label })
        : presenter.renderProgressFailure({ label }, outcome.error)
    }\n`,
  );
  if (operation.kind === "link-launchers" && outcome.status === "failed") {
    await presenter.writeMessage(setupMessageRef("guided.launcher-link-failed"));
  }
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
  return composition.text.text(setupMessageRef("label.setup-operation"));
}

function harnessLabel(facts: SetupFacts | undefined, harnessId: SupportedHarnessId): string {
  return facts?.harnesses.find((harness) => harness.id === harnessId)?.label ?? harnessId;
}

async function renderTmuxFeedback(
  composition: SetupComposition,
  requested: boolean,
): Promise<void> {
  const facts = composition.session.snapshot()?.facts;
  if (facts === undefined || (!requested && facts.tmuxBinding.status !== "ok")) return;
  const presenter = composition.text;
  const popupCommand = formatCommand([facts.launchers.station.command, "popup"]);
  if (facts.tmuxBinding.status === "ok") {
    await presenter.writeMessage(
      setupMessageRef(
        facts.tmuxBinding.liveStatus === "loaded" ? "guided.tmux-loaded" : "guided.tmux-future",
        { key: facts.tmuxBinding.bindingKey },
      ),
    );
  } else if (requested) {
    await presenter.writeMessage(setupMessageRef("guided.tmux-not-persisted"));
  }
  await presenter.writeMessage(
    setupMessageRef("guided.direct-fallback", { command: popupCommand }),
  );
}

async function withPromptPaused<T>(prompt: SetupPromptAdapter, task: () => Promise<T>): Promise<T> {
  prompt.pause?.();
  try {
    return await task();
  } finally {
    prompt.resume?.();
  }
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
  return { code: 1 };
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
