import { type ResolveExecutablePathOptions, resolveExecutablePath } from "@station/runtime";
import type { SetupDependencyFact } from "../adapters/inspectionTypes.js";
import { SETUP_TOOL_DEFINITIONS } from "../toolDefinitions.js";
import { setupEnv } from "./env.js";
import type { SetupDependencyCheckOptions } from "./system.js";

const diffViewerDefinition = SETUP_TOOL_DEFINITIONS["diff-viewer"];

export function diffViewerInstallHint(command = diffViewerDefinition.command): string {
  return `Install ${diffViewerDefinition.displayName} with brew install ${diffViewerDefinition.formula} for the STATION 'See diff' automation. stn tried ${command}.`;
}

/** Maps setup's semantic diff-viewer capability to the Hunk executable shipped by Homebrew. */
export async function checkSetupDiffViewer(
  options: SetupDependencyCheckOptions = {},
): Promise<SetupDependencyFact> {
  const env = setupEnv(options.env);
  const resolveOptions: ResolveExecutablePathOptions = {};
  if (env.PATH !== undefined) resolveOptions.pathEnv = env.PATH;
  if (options.access !== undefined) resolveOptions.access = options.access;
  const resolvedPath = await resolveExecutablePath(diffViewerDefinition.command, resolveOptions);
  if (resolvedPath !== undefined) {
    return { status: "ok", command: diffViewerDefinition.command, resolvedPath };
  }
  return {
    status: "missing",
    command: diffViewerDefinition.command,
    message: diffViewerInstallHint(),
  };
}
