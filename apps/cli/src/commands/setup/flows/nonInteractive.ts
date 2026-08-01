import type { SetupSessionState } from "@station/setup-core";
import { createSetupComposition } from "../composition.js";
import { setupPresenter } from "../io.js";
import { projectSessionView } from "../presentation/projectSessionView.js";
import { overlaySetupActionStatuses } from "../presentation/projectSetupResult.js";
import { projectSetupView } from "../presentation/projectSetupView.js";
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
  const initial = projectCurrentSession(composition, reviewing);
  const presenter = setupPresenter(deps);

  if (flags.dryRun) {
    const verified = await composition.session.application.previewApply();
    const preview = projectCurrentSession(composition, verified);
    const actions = preview.plan.actions.map((action) =>
      action.selected ? { ...action, status: "skipped" as const } : action,
    );
    await presenter.write(presenter.renderPlan(overlaySetupActionStatuses(preview.view, actions)));
    return { code: preview.plan.summary.selectionSource === "unresolved" ? 1 : 0 };
  }

  if (initial.plan.summary.selectionSource === "unresolved") {
    await presenter.write(presenter.renderApplyResult(initial.view));
    return { code: 1 };
  }

  const finished = await composition.session.application.apply();
  const projection = projectCurrentSession(composition, finished);
  if (finished.status === "blocked") {
    if (finished.reason === "observer-activation-failed" && finished.error !== undefined) {
      await presenter.write(
        `${presenter.renderActivationFailure(finished.error, {
          restart: ["stn", "--config", projection.plan.summary.configPath, "observer", "restart"],
          setup: ["stn", "--config", projection.plan.summary.configPath, "setup", "apply", "--yes"],
        })}\n`,
      );
      return { code: 1 };
    }
    if (finished.reason === "config-write-failed") {
      const actions = projection.plan.actions.map((action) =>
        action.kind === "write-config" ? { ...action, status: "failed" as const } : action,
      );
      const failedAction = actions.find((action) => action.kind === "write-config");
      if (failedAction !== undefined) {
        await presenter.write(`${presenter.renderProgressFailure(failedAction, finished.error)}\n`);
      }
      await presenter.write(
        presenter.renderApplyResult(overlaySetupActionStatuses(projection.view, actions)),
      );
      return { code: 1 };
    }
  }

  await presenter.write(presenter.renderApplyResult(projection.view));
  if (finished.status !== "completed") return { code: 1 };
  const failedTracking = finished.result.operationOutcomes.some(
    (outcome) =>
      outcome.status === "failed" &&
      (outcome.operationId.startsWith("prepare-harness-tracking:") ||
        outcome.operationId === "prepare-worktrunk-tracking"),
  );
  return {
    code: !failedTracking && projection.plan.summary.requiredOk ? 0 : 1,
  };
}

function projectCurrentSession(
  composition: ReturnType<typeof createSetupComposition>,
  state: SetupSessionState,
) {
  const snapshot = composition.session.snapshot();
  const sessionView = projectSessionView(state);
  if (snapshot === undefined || sessionView.plan === undefined) {
    throw new Error("Setup session completed without inspectable semantic evidence.");
  }
  const input =
    snapshot.configWrite === undefined
      ? { plan: sessionView.plan, facts: snapshot.facts }
      : { plan: sessionView.plan, facts: snapshot.facts, configWrite: snapshot.configWrite };
  return {
    plan: composition.json.project(input),
    view: projectSetupView(input),
  };
}
