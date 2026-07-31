import { applySetupPlan } from "../apply.js";
import {
  activateCompletedConfigWrite,
  applyOptions,
  collectSetupPlanForCommand,
  coreReadyForConfigWrite,
  depsWithBrewBinPath,
  isConfigAction,
  isHookSetupAction,
  isInstallAction,
} from "../flowUtils.js";
import { setupPresenter } from "../io.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "../types.js";

export async function runNonInteractiveApply(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { dryRun: boolean; noBrew: boolean },
): Promise<SetupCommandResult> {
  const initial = await collectSetupPlanForCommand("apply", options, deps, {
    noBrew: flags.noBrew,
    planConfigWrite: true,
  });
  const presenter = setupPresenter(deps);

  if (flags.dryRun) {
    await applySetupPlan(initial.plan, applyOptions(deps, { dryRun: true, execution: initial }));
    await presenter.write(presenter.renderPlan(initial.presentationView));
    return { code: initial.harnessSelection.source === "unresolved" ? 1 : 0 };
  }

  if (initial.harnessSelection.source === "unresolved") {
    await presenter.write(
      presenter.renderApplyResult(initial.presentationView, { selectionRequired: true }),
    );
    return { code: 1 };
  }

  const installResult = await applySetupPlan(
    initial.plan,
    applyOptions(deps, {
      actionFilter: isInstallAction,
      announceActions: true,
      showCommandOutput: true,
      execution: initial,
    }),
  );
  const reprobeDeps = depsWithBrewBinPath(deps);
  if (installResult.failedAction !== undefined) {
    const final = await collectSetupPlanForCommand("apply", options, reprobeDeps, {
      noBrew: flags.noBrew,
    });
    await presenter.write(presenter.renderApplyResult(final.presentationView));
    return { code: 1 };
  }

  const refreshed = await collectSetupPlanForCommand("apply", options, reprobeDeps, {
    noBrew: flags.noBrew,
    planConfigWrite: true,
  });
  if (!coreReadyForConfigWrite(refreshed.plan)) {
    await presenter.write(presenter.renderApplyResult(refreshed.presentationView));
    return { code: 1 };
  }

  const writeResult = await applySetupPlan(
    refreshed.plan,
    applyOptions(reprobeDeps, {
      actionFilter: isConfigAction,
      announceActions: true,
      execution: refreshed,
    }),
  );
  if (writeResult.failedAction !== undefined) {
    await presenter.write(presenter.renderApplyResult(refreshed.presentationView));
    return { code: 1 };
  }

  const activationError = await activateCompletedConfigWrite(refreshed, reprobeDeps);
  if (activationError !== undefined) {
    return { code: 1 };
  }

  const trackingPlan = await collectSetupPlanForCommand("apply", options, reprobeDeps, {
    noBrew: flags.noBrew,
  });
  const trackingResult = await applySetupPlan(
    trackingPlan.plan,
    applyOptions(reprobeDeps, {
      actionFilter: isHookSetupAction,
      announceActions: true,
      showCommandOutput: true,
      execution: trackingPlan,
    }),
  );

  // Operation outcomes do not prove readiness; rebuild the plan from current config and artifacts.
  const final = await collectSetupPlanForCommand("apply", options, reprobeDeps, {
    noBrew: flags.noBrew,
  });
  await presenter.write(presenter.renderApplyResult(final.presentationView));
  return {
    code: trackingResult.failedAction === undefined && final.plan.summary.requiredOk ? 0 : 1,
  };
}
