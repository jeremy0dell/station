import { parseSetupArgs } from "./args.js";
import { runGuidedSetup } from "./flows/guided.js";
import { runNonInteractiveApply } from "./flows/nonInteractive.js";
import { runSetupCheckCommand, runSetupPlanCommand } from "./flows/readOnly.js";
import { write } from "./io.js";
import { runSetupSystemCommand } from "./systemCommand.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "./types.js";

export type {
  SetupCommandDeps,
  SetupCommandOptions,
  SetupCommandResult,
  SetupPromptAdapter,
  SetupPromptChoice,
} from "./types.js";

export async function runSetupCommand(
  argv: readonly string[],
  options: SetupCommandOptions = {},
  deps: SetupCommandDeps = {},
): Promise<SetupCommandResult> {
  let args: ReturnType<typeof parseSetupArgs>;
  try {
    args = parseSetupArgs(argv);
  } catch (error) {
    await write(
      deps,
      `${error instanceof Error ? error.message : String(error)}\n\n${renderSetupHelp(["setup"], options)}`,
    );
    return { code: 2 };
  }

  if (args.help) {
    const helpPath = args.kind === "guided" ? ["setup"] : ["setup", args.kind];
    await write(deps, renderSetupHelp(helpPath, options));
    return { code: 0 };
  }

  switch (args.kind) {
    case "system":
      return runSetupSystemCommand(args, options, deps);
    case "check":
      return runSetupCheckCommand(options, deps, { json: args.json, noBrew: args.noBrew });
    case "plan":
      return runSetupPlanCommand(options, deps, { json: args.json, noBrew: args.noBrew });
    case "apply":
      return runNonInteractiveApply(options, deps, {
        dryRun: args.dryRun,
        noBrew: args.noBrew,
      });
    case "guided":
      return runGuidedSetup(options, deps);
  }
}

function renderSetupHelp(path: readonly string[], options: SetupCommandOptions): string {
  return options.renderHelp?.(path) ?? "Usage: station setup [check|plan|apply|system]\n";
}
