import { loadConfig, loadConfigFromToml } from "../load/index.js";
import { projectConfigSafeError } from "./errors.js";
import { findGitRoot, resolveExistingDirectory } from "./git.js";
import {
  labelFromRoot,
  minimalBlockFromProject,
  projectIdFromRoot,
  samePath,
  uniqueProjectId,
} from "./ids.js";
import { atomicWriteConfig, loadConfigSource } from "./source.js";
import { appendProjectBlock } from "./tomlBlocks.js";
import type {
  AddProjectToConfigOptions,
  AddProjectToConfigResult,
  MinimalProjectBlock,
} from "./types.js";

export async function addProjectToConfig(
  options: AddProjectToConfigOptions,
): Promise<AddProjectToConfigResult> {
  const loaded = await loadConfigSource(options);
  const selectedPath = await resolveExistingDirectory(options.path, loaded.homeDir);
  const gitRoot = await findGitRoot(selectedPath);
  if (gitRoot === undefined && options.allowNonGit !== true) {
    throw projectConfigSafeError({
      code: "PROJECT_ROOT_NOT_GIT",
      message: "Selected folder is not inside a git repository.",
      hint: "Choose a git repository or pass --allow-non-git to add this folder anyway.",
    });
  }

  const root = gitRoot ?? selectedPath;
  const existingProject = loaded.loaded.projects.find((project) => samePath(project.root, root));
  if (existingProject !== undefined) {
    return {
      status: "unchanged",
      configPath: loaded.configPath,
      selectedPath,
      ...(gitRoot === undefined ? {} : { gitRoot }),
      project: existingProject,
      writtenBlock: minimalBlockFromProject(existingProject),
      config: loaded.loaded.config,
    };
  }

  const requestedId = options.id ?? projectIdFromRoot(root);
  const id = uniqueProjectId(requestedId, loaded.loaded.projects);
  const label = options.label ?? labelFromRoot(root);
  const block: MinimalProjectBlock = { id, label, root };
  const candidateSource = appendProjectBlock(loaded.source, block);

  await loadConfigFromToml(candidateSource, {
    configPath: loaded.configPath,
    homeDir: loaded.homeDir,
  });
  await atomicWriteConfig(loaded.configPath, candidateSource);
  const after = await loadConfig({ configPath: loaded.configPath, homeDir: loaded.homeDir });
  const project = after.projects.find((candidate) => candidate.id === id);
  if (project === undefined) {
    throw projectConfigSafeError({
      code: "PROJECT_ADD_VALIDATION_FAILED",
      message: "Config updated, but the added project was not present after reload.",
    });
  }

  return {
    status: "added",
    configPath: loaded.configPath,
    selectedPath,
    ...(gitRoot === undefined ? {} : { gitRoot }),
    project,
    writtenBlock: block,
    config: after.config,
  };
}
