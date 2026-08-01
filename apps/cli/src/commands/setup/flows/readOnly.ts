import { createSetupComposition } from "../composition.js";
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
  const projection = composition.project(state);
  if (projection.status === "unavailable") {
    if (flags.json) throw projection.error;
    await composition.text.write(`${composition.text.renderInspectionFailure(projection.error)}\n`);
    return { code: 1 };
  }
  if (flags.json) {
    return {
      code: projection.plan.summary.requiredOk ? 0 : 1,
      output: projection.plan,
    };
  }
  await composition.text.write(composition.text.renderPlan(projection.view));
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
  const projection = composition.project(state);
  if (projection.status === "unavailable") {
    if (flags.json) throw projection.error;
    await composition.text.write(`${composition.text.renderInspectionFailure(projection.error)}\n`);
    return { code: 1 };
  }
  if (flags.json) return { code: 0, output: projection.plan };
  await composition.text.write(composition.text.renderPlan(projection.view));
  return { code: 0 };
}
