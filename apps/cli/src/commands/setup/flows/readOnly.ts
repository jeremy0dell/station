import { createSetupComposition } from "../composition.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "../types.js";

type ReadOnlySetupCommand = (
  ...commandArguments: [
    options: SetupCommandOptions,
    deps: SetupCommandDeps,
    flags: { readonly json: boolean; readonly noBrew: boolean },
  ]
) => Promise<SetupCommandResult>;

export const runSetupCheckCommand = createReadOnlySetupCommand("check");
export const runSetupPlanCommand = createReadOnlySetupCommand("plan");

function createReadOnlySetupCommand(mode: "check" | "plan"): ReadOnlySetupCommand {
  return async (...commandArguments) => {
    const [options, deps, flags] = commandArguments;
    const composition = createSetupComposition({
      mode,
      options,
      deps,
      noBrew: flags.noBrew,
      planConfigWrite: mode === "plan",
    });
    const state = await composition.session.application.review();
    const projection = composition.project(state);
    if (projection.status === "unavailable") {
      if (flags.json) throw projection.error;
      await composition.text.write(
        `${composition.text.renderInspectionFailure(projection.error)}\n`,
      );
      return { code: 1 };
    }
    const code = mode === "check" && !projection.plan.summary.requiredOk ? 1 : 0;
    if (flags.json) return { code, output: projection.plan };
    await composition.text.write(composition.text.renderPlan(projection.text));
    return { code };
  };
}
