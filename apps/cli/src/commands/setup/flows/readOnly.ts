import type { SetupSessionState } from "@station/setup-core";
import { createSetupComposition } from "../composition.js";
import { setupPresenter } from "../io.js";
import { projectSessionView } from "../presentation/projectSessionView.js";
import { projectSetupView } from "../presentation/projectSetupView.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "../types.js";

export async function runSetupCheckCommand(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { json: boolean; noBrew: boolean },
): Promise<SetupCommandResult> {
  const composition = createSetupComposition({
    mode: "check",
    options,
    deps,
    noBrew: flags.noBrew,
    planConfigWrite: false,
  });
  const state = await composition.session.application.review();
  const projection = projectCurrentSession(composition, state);
  if (flags.json) {
    return {
      code: projection.plan.summary.requiredOk ? 0 : 1,
      output: projection.plan,
    };
  }
  const presenter = setupPresenter(deps);
  await presenter.write(presenter.renderPlan(projection.view));
  return { code: projection.plan.summary.requiredOk ? 0 : 1 };
}

export async function runSetupPlanCommand(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { json: boolean; noBrew: boolean },
): Promise<SetupCommandResult> {
  const composition = createSetupComposition({
    mode: "plan",
    options,
    deps,
    noBrew: flags.noBrew,
    planConfigWrite: true,
  });
  const state = await composition.session.application.review();
  const projection = projectCurrentSession(composition, state);
  if (flags.json) return { code: 0, output: projection.plan };
  const presenter = setupPresenter(deps);
  await presenter.write(presenter.renderPlan(projection.view));
  return { code: 0 };
}

function projectCurrentSession(
  composition: ReturnType<typeof createSetupComposition>,
  state: SetupSessionState,
) {
  const snapshot = composition.session.snapshot();
  const sessionView = projectSessionView(state);
  if (snapshot === undefined || sessionView.plan === undefined) {
    const reason = state.status === "blocked" ? ` (${state.error?.code ?? state.reason})` : "";
    throw new Error(`Setup session completed without inspectable semantic evidence${reason}.`);
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
