import type { CliRunResult } from "../cliTypes.js";
import type { UpdateConvergencePort } from "../update/updateConvergencePort.js";
import { parseUpdateRequest } from "./update/args.js";
import { updateCommandResult } from "./update/report.js";

export type UpdateCommandDeps = {
  convergence: UpdateConvergencePort;
};

/**
 * ADAPTER
 *
 * Translates update arguments and one strict convergence report into the shared CLI result.
 */
export async function runUpdateCommand(
  args: readonly string[],
  deps: UpdateCommandDeps,
): Promise<CliRunResult> {
  const parsed = parseUpdateRequest(args);
  const { output, ...request } = parsed;
  const report = await deps.convergence.run(request);
  return updateCommandResult(report, output);
}
