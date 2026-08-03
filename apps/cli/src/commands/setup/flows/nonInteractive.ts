import type {
  SetupSessionFailedOperationOutcome,
  SetupSessionOperationOutcome,
} from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import type { SetupFacts } from "../adapters/inspectionTypes.js";
import { createSetupComposition, type ProjectedSetupSession } from "../composition.js";
import { overlaySetupOperationOutcomes } from "../presentation/projectSetupResult.js";
import type { TextSetupPresenter } from "../presenters/text.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "../types.js";

export async function runNonInteractiveApply(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { dryRun: boolean; noBrew: boolean },
): Promise<SetupCommandResult> {
  const composition = createSetupComposition({
    mode: "apply",
    options,
    deps,
    noBrew: flags.noBrew,
    planConfigWrite: true,
  });
  const reviewing = await composition.session.application.review();
  const initial = composition.project(reviewing);
  if (initial.status === "unavailable") {
    await composition.text.write(`${composition.text.renderInspectionFailure(initial.error)}\n`);
    return { code: 1 };
  }

  if (flags.dryRun) {
    const verified = await composition.session.application.previewApply();
    const preview = composition.project(verified);
    if (preview.status === "unavailable") {
      await composition.text.write(`${composition.text.renderInspectionFailure(preview.error)}\n`);
      return { code: 1 };
    }
    const view = {
      ...preview.view,
      actions: preview.view.actions.map((action) =>
        action.selected ? { ...action, status: "skipped" as const } : action,
      ),
    };
    await composition.text.write(composition.text.renderPlan(view));
    return { code: preview.plan.summary.selectionSource === "unresolved" ? 1 : 0 };
  }

  if (initial.plan.summary.selectionSource === "unresolved") {
    await composition.text.write(composition.text.renderApplyResult(initial.view));
    return { code: 1 };
  }

  const finished = await composition.session.application.apply();
  const projection = composition.project(finished);
  if (projection.status === "unavailable") {
    await composition.text.write(`${composition.text.renderInspectionFailure(projection.error)}\n`);
    return { code: 1 };
  }
  const view = overlaySetupOperationOutcomes({
    view: projection.view,
    outcomes: projection.session.operationOutcomes,
  });

  if (finished.status === "blocked") {
    if (finished.reason === "observer-activation-failed" && finished.error !== undefined) {
      await composition.text.write(
        `${composition.text.renderActivationFailure(finished.error, {
          restart: ["stn", "--config", projection.plan.summary.configPath, "observer", "restart"],
          setup: ["stn", "--config", projection.plan.summary.configPath, "setup", "apply", "--yes"],
        })}\n`,
      );
    } else {
      await renderOperationFailures(
        projection,
        composition.session.snapshot()?.facts,
        composition.text,
      );
    }
    await composition.text.write(composition.text.renderApplyResult(view));
    return { code: 1 };
  }

  await renderOperationFailures(
    projection,
    composition.session.snapshot()?.facts,
    composition.text,
  );
  await composition.text.write(composition.text.renderApplyResult(view));
  const operationFailed = projection.session.operationOutcomes.some(
    (outcome) => outcome.status === "failed",
  );
  return {
    code:
      finished.status === "completed" && !operationFailed && projection.plan.summary.requiredOk
        ? 0
        : 1,
  };
}

async function renderOperationFailures(
  projection: ProjectedSetupSession,
  facts: SetupFacts | undefined,
  presenter: TextSetupPresenter,
): Promise<void> {
  const failures = projection.session.operationOutcomes.filter(
    (outcome): outcome is SetupSessionFailedOperationOutcome => outcome.status === "failed",
  );
  if (failures.length === 0 && projection.session.error !== undefined) {
    await presenter.write(`${presenter.renderInspectionFailure(projection.session.error)}\n`);
    return;
  }
  for (const failure of failures) {
    const matchingActions = projection.view.actions.filter(
      (candidate) => candidate.operationId === failure.operationId,
    );
    const action =
      matchingActions.find((candidate) => candidate.kind === failure.operation.kind) ??
      matchingActions[0];
    const label =
      action === undefined
        ? operationFailureLabel(failure, facts, presenter)
        : presenter.text(action.label);
    await presenter.write(`${presenter.renderProgressFailure({ label }, failure.error)}\n`);
  }
}

function operationFailureLabel(
  outcome: SetupSessionOperationOutcome,
  facts: SetupFacts | undefined,
  presenter: TextSetupPresenter,
): string {
  const operation = outcome.operation;
  switch (operation.kind) {
    case "install-harness": {
      const harness = facts?.harnesses.find((candidate) => candidate.id === operation.harnessId);
      return presenter.text(
        setupMessageRef("action.install-label", {
          label: harness?.label ?? operation.harnessId,
        }),
      );
    }
    case "install-homebrew":
      return presenter.text(
        setupMessageRef("action.install-label", {
          label: presenter.text(setupMessageRef("label.homebrew")),
        }),
      );
    case "install-xcode-command-line-tools":
      return presenter.text(
        setupMessageRef("action.install-label", {
          label: presenter.text(setupMessageRef("label.command-line-tools")),
        }),
      );
    case "activate-observer-config":
      return presenter.text(setupMessageRef("label.observer-activation"));
    case "install-tool":
    case "link-launchers":
    case "configure-worktrunk-shell":
    case "configure-tmux-popup":
    case "prepare-worktrunk-tracking":
    case "prepare-harness-tracking":
    case "write-config":
      return presenter.text(setupMessageRef("label.setup-operation"));
    default:
      return assertNeverOutcome(operation);
  }
}

function assertNeverOutcome(operation: never): never {
  throw new Error(`Unsupported setup operation: ${String(operation)}`);
}
