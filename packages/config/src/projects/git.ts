import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveConfigPath } from "../load/paths.js";
import { isProjectSafeError, projectConfigSafeError } from "./errors.js";

export async function findGitRoot(startPath: string): Promise<string | undefined> {
  let current = resolve(startPath);
  for (;;) {
    if (await hasGitMarker(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function resolveExistingDirectory(
  inputPath: string,
  homeDir: string,
): Promise<string> {
  const resolvedPath = resolveConfigPath(inputPath, homeDir, process.cwd());
  try {
    const rootStat = await stat(resolvedPath);
    if (!rootStat.isDirectory()) {
      throw projectConfigSafeError({
        code: "PROJECT_ROOT_INVALID",
        message: "Selected project path is not a directory.",
      });
    }
  } catch (cause) {
    if (isProjectSafeError(cause)) {
      throw cause;
    }
    throw projectConfigSafeError({
      code: "PROJECT_ROOT_INVALID",
      message: "Selected project path is not an existing directory.",
      hint: resolvedPath,
    });
  }
  return resolvedPath;
}

async function hasGitMarker(directory: string): Promise<boolean> {
  const marker = join(directory, ".git");
  try {
    const markerStat = await stat(marker);
    return markerStat.isDirectory() || markerStat.isFile();
  } catch {
    return false;
  }
}
