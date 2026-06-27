import { loadConfig, loadConfigFromToml } from "../load/index.js";
import { projectConfigSafeError } from "./errors.js";
import { atomicWriteConfig, loadConfigSource } from "./source.js";
import { setProjectDefaultHarness } from "./tomlBlocks.js";
import type { SetProjectDefaultHarnessOptions, SetProjectDefaultHarnessResult } from "./types.js";

export async function setProjectDefaultHarnessInConfig(
  options: SetProjectDefaultHarnessOptions,
): Promise<SetProjectDefaultHarnessResult> {
  const loaded = await loadConfigSource(options);
  const project = loaded.loaded.projects.find((candidate) => candidate.id === options.projectId);
  if (project === undefined) {
    throw projectConfigSafeError({
      code: "PROJECT_NOT_CONFIGURED",
      message: `Project "${options.projectId}" is not configured.`,
      projectId: options.projectId,
    });
  }

  if (project.defaults.harness === options.harness) {
    return {
      status: "unchanged",
      configPath: loaded.configPath,
      projectId: options.projectId,
      harness: options.harness,
      config: loaded.loaded.config,
    };
  }

  const candidateSource = setProjectDefaultHarness(
    loaded.source,
    options.projectId,
    options.harness,
  );
  const candidate = await loadConfigFromToml(candidateSource, {
    configPath: loaded.configPath,
    homeDir: loaded.homeDir,
  });
  const candidateProject = candidate.projects.find(
    (nextProject) => nextProject.id === options.projectId,
  );
  if (candidateProject?.defaults.harness !== options.harness) {
    const hint =
      candidateProject?.localConfig?.enabled === true
        ? `Edit ${candidateProject.localConfig.path} or remove its [defaults].harness override.`
        : undefined;
    throw projectConfigSafeError({
      code: "PROJECT_DEFAULT_HARNESS_OVERRIDDEN",
      message: `Project "${options.projectId}" has a default harness override that keeps "${candidateProject?.defaults.harness ?? "unknown"}" effective.`,
      projectId: options.projectId,
      ...(hint === undefined ? {} : { hint }),
    });
  }
  await atomicWriteConfig(loaded.configPath, candidateSource);
  const after = await loadConfig({ configPath: loaded.configPath, homeDir: loaded.homeDir });

  return {
    status: "updated",
    configPath: loaded.configPath,
    projectId: options.projectId,
    harness: options.harness,
    config: after.config,
  };
}
