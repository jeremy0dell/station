import { type ResolveExecutablePathOptions, resolveExecutablePath } from "@station/runtime";
import type { SetupDependencyFact } from "../adapters/inspectionTypes.js";
import { SETUP_TOOL_DEFINITIONS } from "../toolDefinitions.js";
import { setupEnv } from "./env.js";
import type { SetupDependencyCheckOptions } from "./system.js";

export function bunInstallHint(command = SETUP_TOOL_DEFINITIONS.bun.command): string {
  return [
    `Install Bun with brew install ${SETUP_TOOL_DEFINITIONS.bun.formula} to run the STATION terminal UI.`,
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
  const command = SETUP_TOOL_DEFINITIONS.bun.command;
  // Mirror tui.ts and doctor's rendererRuntimeCheck: a STATION_DASHBOARD_COMMAND
  // override replaces `bun run`, so Bun is not required to launch the dashboard and
  // must not block core setup (else doctor reports healthy while setup check exits 1).
  if (env.STATION_DASHBOARD_COMMAND !== undefined) {
    return { status: "ok", command };
  }
  const resolveOptions: ResolveExecutablePathOptions = {};
  if (env.PATH !== undefined) resolveOptions.pathEnv = env.PATH;
  if (options.access !== undefined) resolveOptions.access = options.access;
  const resolvedPath = await resolveExecutablePath(command, resolveOptions);
  if (resolvedPath !== undefined) {
    return { status: "ok", command, resolvedPath };
  }
  return { status: "missing", command, message: bunInstallHint(command) };
}
