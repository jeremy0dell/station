import { loadConfig, loadConfigFromToml } from "../load/index.js";
import { projectConfigSafeError } from "./errors.js";
import { atomicWriteConfig, loadConfigSource } from "./source.js";
import { removeProjectBlock } from "./tomlBlocks.js";
import type { RemoveProjectFromConfigOptions, RemoveProjectFromConfigResult } from "./types.js";

export async function removeProjectFromConfig(
  options: RemoveProjectFromConfigOptions,
): Promise<RemoveProjectFromConfigResult> {
  const loaded = await loadConfigSource(options);
  const removedProject = loaded.loaded.projects.find((project) => project.id === options.projectId);
  if (removedProject === undefined) {
    throw projectConfigSafeError({
      code: "PROJECT_NOT_CONFIGURED",
      message: `Project "${options.projectId}" is not configured.`,
      projectId: options.projectId,
    });
  }

  const candidateSource = removeProjectBlock(loaded.source, options.projectId);
  await loadConfigFromToml(candidateSource, {
    configPath: loaded.configPath,
    homeDir: loaded.homeDir,
  });
  await atomicWriteConfig(loaded.configPath, candidateSource);
  const after = await loadConfig({ configPath: loaded.configPath, homeDir: loaded.homeDir });

  return {
    status: "removed",
    configPath: loaded.configPath,
    projectId: options.projectId,
    removedProject,
    config: after.config,
  };
}
