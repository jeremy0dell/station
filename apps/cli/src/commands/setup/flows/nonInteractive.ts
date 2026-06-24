import { applySetupPlan } from "../apply.js";
import { planSetupConfigWrite } from "../configWriter.js";
import {
  applyOptions,
  collectForCommand,
  coreReadyForConfigWrite,
  isConfigAction,
  isInstallAction,
  markRequiredIncomplete,
} from "../flowUtils.js";
import { renderOptions, write } from "../io.js";
import { buildSetupPlan } from "../planner.js";
import { renderSetupApplyResult, renderSetupPlan } from "../render.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "../types.js";

export async function runNonInteractiveApply(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { dryRun: boolean; noBrew: boolean },
): Promise<SetupCommandResult> {
  const initialFacts = await collectForCommand("apply", options, deps, { noBrew: flags.noBrew });
  const initialConfigWrite = await planSetupConfigWrite(initialFacts);
  const initialPlan = buildSetupPlan(initialFacts, { configWrite: initialConfigWrite });

  if (flags.dryRun) {
    const dryRun = await applySetupPlan(initialPlan, applyOptions(deps, { dryRun: true }));
    await write(deps, renderSetupPlan(dryRun.plan, renderOptions(deps)));
    return { code: 0 };
  }

  const installResult = await applySetupPlan(
    initialPlan,
    applyOptions(deps, {
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
    return { code: 1 };
  }

  const refreshedFacts = await collectForCommand("apply", options, deps, { noBrew: flags.noBrew });
  const configWrite = await planSetupConfigWrite(refreshedFacts);
  const refreshedPlan = buildSetupPlan(refreshedFacts, { configWrite });
  if (!coreReadyForConfigWrite(refreshedPlan)) {
    await write(deps, renderSetupApplyResult(refreshedPlan, renderOptions(deps)));
    return { code: 1 };
  }

  const writeResult = await applySetupPlan(
    refreshedPlan,
    applyOptions(deps, { actionFilter: isConfigAction, announceActions: true }),
  );
  const outputPlan =
    writeResult.failedAction === undefined
      ? { ...writeResult.plan, summary: { ...writeResult.plan.summary, requiredOk: true } }
      : writeResult.plan;
  await write(deps, renderSetupApplyResult(outputPlan, renderOptions(deps)));
  return { code: writeResult.failedAction === undefined ? 0 : 1 };
}
