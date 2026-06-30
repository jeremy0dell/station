import { type ResolveExecutablePathOptions, resolveExecutablePath } from "@station/runtime";
import type { SetupDependencyFact } from "../model.js";
import { setupEnv } from "./env.js";
import type { SetupDependencyCheckOptions } from "./system.js";

export const defaultBunCommand = "bun";

export function bunInstallHint(command = defaultBunCommand): string {
  return [
    "Install Bun with brew install bun to run the STATION terminal UI.",
    `Bare stn launches the dashboard through ${command} run.`,
  ].join(" ");
}

/**
 * Required Bun probe. Bare `stn` renders the TUI via `bun run` against the
 * station workspace, so a missing Bun makes the primary terminal UI fail to
 * launch. Presence of the command on PATH is enough; absence blocks core setup.
 */
export async function checkSetupBun(
  options: SetupDependencyCheckOptions = {},
): Promise<SetupDependencyFact> {
  const env = setupEnv(options.env);
  const command = defaultBunCommand;
  const resolveOptions: ResolveExecutablePathOptions = {};
  if (env.PATH !== undefined) resolveOptions.pathEnv = env.PATH;
  if (options.access !== undefined) resolveOptions.access = options.access;
  const resolvedPath = await resolveExecutablePath(command, resolveOptions);
  if (resolvedPath !== undefined) {
    return { status: "ok", command, resolvedPath };
  }
  return { status: "missing", command, message: bunInstallHint(command) };
}
