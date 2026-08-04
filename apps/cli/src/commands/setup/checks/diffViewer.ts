import { type ResolveExecutablePathOptions, resolveExecutablePath } from "@station/runtime";
import type { SetupDependencyFact } from "../adapters/inspectionTypes.js";
import { defaultDiffViewer } from "../defaultDiffViewer.js";
import { setupEnv } from "./env.js";
import type { SetupDependencyCheckOptions } from "./system.js";

export function diffViewerInstallHint(command = defaultDiffViewer.command): string {
  return `${defaultDiffViewer.installHint} stn tried ${command}.`;
}

/** Maps setup's semantic diff-viewer capability to the Hunk executable shipped by Homebrew. */
export async function checkSetupDiffViewer(
  options: SetupDependencyCheckOptions = {},
): Promise<SetupDependencyFact> {
  const env = setupEnv(options.env);
  const resolveOptions: ResolveExecutablePathOptions = {};
  if (env.PATH !== undefined) resolveOptions.pathEnv = env.PATH;
  if (options.access !== undefined) resolveOptions.access = options.access;
  const resolvedPath = await resolveExecutablePath(defaultDiffViewer.command, resolveOptions);
  if (resolvedPath !== undefined) {
    return { status: "ok", command: defaultDiffViewer.command, resolvedPath };
  }
  return {
    status: "missing",
    command: defaultDiffViewer.command,
    message: diffViewerInstallHint(),
  };
}
