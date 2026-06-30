import { type ResolveExecutablePathOptions, resolveExecutablePath } from "@station/runtime";
import type { SetupDependencyFact } from "../model.js";
import { setupEnv } from "./env.js";
import type { SetupDependencyCheckOptions } from "./system.js";

export const defaultDiffnavCommand = "diffnav";

export function diffnavInstallHint(command = defaultDiffnavCommand): string {
  return [
    "Install diffnav with brew install dlvhdr/formulae/diffnav for the STATION 'See diff' automation.",
    `stn tried ${command}.`,
  ].join(" ");
}

/**
 * Required diffnav probe for STATION's "See diff" automation. Presence of the
 * literal command on PATH is enough; absence blocks core setup.
 */
export async function checkSetupDiffnav(
  options: SetupDependencyCheckOptions = {},
): Promise<SetupDependencyFact> {
  const env = setupEnv(options.env);
  const command = defaultDiffnavCommand;
  const resolveOptions: ResolveExecutablePathOptions = {};
  if (env.PATH !== undefined) resolveOptions.pathEnv = env.PATH;
  if (options.access !== undefined) resolveOptions.access = options.access;
  const resolvedPath = await resolveExecutablePath(command, resolveOptions);
  if (resolvedPath !== undefined) {
    return { status: "ok", command, resolvedPath };
  }
  return { status: "missing", command, message: diffnavInstallHint(command) };
}
