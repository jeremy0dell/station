import { createSetupComposition } from "../composition.js";
import { runGuidedSetupSession } from "../session/runGuidedSetupSession.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "../types.js";

export function runGuidedSetup(
  ...arguments_: [SetupCommandOptions, SetupCommandDeps]
): Promise<SetupCommandResult> {
  const [options, deps] = arguments_;
  return runGuidedSetupSession(options, (guidedOptions, operationProgress, initialIntent) =>
    createSetupComposition({
      mode: "apply",
      options: guidedOptions,
      deps,
      noBrew: false,
      planConfigWrite: true,
      initialIntent,
      operationProgress,
    }),
  );
}
