import { type ResolveExecutablePathOptions, resolveExecutablePath } from "@station/runtime";
import type { SetupDependencyFact } from "../adapters/inspectionTypes.js";
import { SETUP_TOOL_DEFINITIONS } from "../toolDefinitions.js";
import { setupEnv } from "./env.js";
import type { SetupDependencyCheckOptions } from "./system.js";

const bunDefinition = SETUP_TOOL_DEFINITIONS.bun;

export function bunInstallHint(command = bunDefinition.command): string {
  return [
    `Install ${bunDefinition.displayName} with brew install ${bunDefinition.formula} to run the STATION terminal UI.`,
    `Bare stn launches the dashboard through ${command} run.`,
  ].join(" ");
}

/**
 * Required source-renderer probe. Bare source `stn` runs the root-managed
 * Station workspace through Bun, so absence blocks core setup. Exact Bun policy
 * is reported separately by the source-only development toolchain check.
 */
export async function checkSetupBun(
  options: SetupDependencyCheckOptions = {},
): Promise<SetupDependencyFact> {
  const env = setupEnv(options.env);
  const command = bunDefinition.command;
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
