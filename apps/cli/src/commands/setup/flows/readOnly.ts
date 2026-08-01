import { collectSetupPlanForCommand } from "../flowUtils.js";
import { setupPresenter } from "../io.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "../types.js";

export async function runSetupCheckCommand(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { json: boolean; noBrew: boolean },
): Promise<SetupCommandResult> {
  const collected = await collectSetupPlanForCommand("check", options, deps, {
    noBrew: flags.noBrew,
  });
  if (flags.json) {
    return {
      code: collected.plan.summary.requiredOk ? 0 : 1,
      output: collected.plan,
    };
  }
  const presenter = setupPresenter(deps);
  await presenter.write(presenter.renderPlan(collected.presentationView));
  return { code: collected.plan.summary.requiredOk ? 0 : 1 };
}

export async function runSetupPlanCommand(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { json: boolean; noBrew: boolean },
): Promise<SetupCommandResult> {
  const collected = await collectSetupPlanForCommand("plan", options, deps, {
    noBrew: flags.noBrew,
    planConfigWrite: true,
  });
  if (flags.json) return { code: 0, output: collected.plan };
  const presenter = setupPresenter(deps);
  await presenter.write(presenter.renderPlan(collected.presentationView));
  return { code: 0 };
}
