import {
  addProjectToConfig,
  removeProjectFromConfig,
  setProjectDefaultHarnessInConfig,
} from "@station/config";
import type { ProjectConfigWriter } from "../commands/projectConfigWriter.js";

/**
 * ADAPTER
 *
 * Applies Observer project mutations through `@station/config` while retaining
 * config and home paths at the filesystem boundary.
 */
export function createProjectConfigWriter(input: {
  homeDir: string;
  configPath?: string | undefined;
}): ProjectConfigWriter {
  const paths = {
    homeDir: input.homeDir,
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
  };

  return {
    async addProject(payload) {
      const mutation = {
        path: payload.path,
        ...paths,
        ...(payload.id === undefined ? {} : { id: payload.id }),
        ...(payload.label === undefined ? {} : { label: payload.label }),
        ...(payload.allowNonGit === undefined ? {} : { allowNonGit: payload.allowNonGit }),
      };
      const result = await addProjectToConfig(mutation);
      return result.config;
    },
    async removeProject(payload) {
      const result = await removeProjectFromConfig({ ...payload, ...paths });
      return result.config;
    },
    async setDefaultHarness(payload) {
      const result = await setProjectDefaultHarnessInConfig({ ...payload, ...paths });
      return result.config;
    },
  };
}
