import { collectSetupPlanForCommand } from "../flowUtils.js";
import { renderOptions, write } from "../io.js";
import { renderSetupPlan } from "../render.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "../types.js";

export async function runSetupCheckCommand(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { json: boolean; noBrew: boolean },
): Promise<SetupCommandResult> {
  const { plan } = await collectSetupPlanForCommand("check", options, deps, {
    noBrew: flags.noBrew,
  });
  if (flags.json) return { code: plan.summary.requiredOk ? 0 : 1, output: plan };
  await write(deps, renderSetupPlan(plan, renderOptions(deps)));
  return { code: plan.summary.requiredOk ? 0 : 1 };
}

export async function runSetupPlanCommand(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { json: boolean; noBrew: boolean },
): Promise<SetupCommandResult> {
  const { plan } = await collectSetupPlanForCommand("plan", options, deps, {
    noBrew: flags.noBrew,
    planConfigWrite: true,
  });
  if (flags.json) return { code: 0, output: plan };
  await write(deps, renderSetupPlan(plan, renderOptions(deps)));
  return { code: 0 };
}
