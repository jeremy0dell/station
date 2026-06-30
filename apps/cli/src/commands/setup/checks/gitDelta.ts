import { type ResolveExecutablePathOptions, resolveExecutablePath } from "@station/runtime";
import type { SetupDependencyFact } from "../model.js";
import { setupEnv } from "./env.js";
import type { SetupDependencyCheckOptions } from "./system.js";

// git-delta installs its binary as `delta`; the Homebrew formula is `git-delta`.
export const defaultGitDeltaCommand = "delta";

export function gitDeltaInstallHint(command = defaultGitDeltaCommand): string {
  return [
    "Install git-delta with brew install git-delta — diffnav renders the STATION 'See diff' automation through it.",
    `stn tried ${command}.`,
  ].join(" ");
}

/**
 * Required delta probe paired with diffnav; without it, the "See diff" automation
 * can resolve diffnav but still fail while rendering, so delta moves with diffnav.
 */
export async function checkSetupGitDelta(
  options: SetupDependencyCheckOptions = {},
): Promise<SetupDependencyFact> {
  const env = setupEnv(options.env);
  const command = defaultGitDeltaCommand;
  const resolveOptions: ResolveExecutablePathOptions = {};
  if (env.PATH !== undefined) resolveOptions.pathEnv = env.PATH;
  if (options.access !== undefined) resolveOptions.access = options.access;
  const resolvedPath = await resolveExecutablePath(command, resolveOptions);
  if (resolvedPath !== undefined) {
    return { status: "ok", command, resolvedPath };
  }
  return { status: "missing", command, message: gitDeltaInstallHint(command) };
}
