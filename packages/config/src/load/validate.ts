import { stat } from "node:fs/promises";
import { normalize } from "node:path";
import type { ProjectConfig } from "../schema.js";
import { ConfigError } from "./errors.js";

export async function validateProjectRoots(
  projects: readonly ProjectConfig[],
  configPath: string,
): Promise<void> {
  for (const project of projects) {
    try {
      const rootStat = await stat(project.root);
      if (!rootStat.isDirectory()) {
        throw new ConfigError({
          code: "CONFIG_INVALID_PROJECT_ROOT",
          message: `Project "${project.id}" root must be an existing directory.`,
          configPath,
          projectId: project.id,
        });
      }
    } catch (cause) {
      if (cause instanceof ConfigError) {
        throw cause;
      }

      throw new ConfigError({
        code: "CONFIG_INVALID_PROJECT_ROOT",
        message: `Project "${project.id}" root must be an existing directory.`,
        configPath,
        projectId: project.id,
        cause,
      });
    }
  }
}

export function validateProjectIdentifiers(
  projects: readonly ProjectConfig[],
  configPath: string,
): void {
  const projectIds = new Set<string>();

  for (const project of projects) {
    if (projectIds.has(project.id)) {
      throw new ConfigError({
        code: "CONFIG_DUPLICATE_PROJECT_ID",
        message: `Project ID "${project.id}" is defined more than once.`,
        configPath,
        projectId: project.id,
      });
    }

    projectIds.add(project.id);
  }

  const aliases = new Map<string, string>();

  for (const project of projects) {
    for (const alias of project.aliases ?? []) {
      if (projectIds.has(alias)) {
        throw new ConfigError({
          code: "CONFIG_ALIAS_PROJECT_ID_COLLISION",
          message: `Project alias "${alias}" collides with a project ID.`,
          configPath,
          projectId: project.id,
        });
      }

      const previousProjectId = aliases.get(alias);
      if (previousProjectId !== undefined) {
        throw new ConfigError({
          code: "CONFIG_DUPLICATE_ALIAS",
          message: `Project alias "${alias}" is used by both "${previousProjectId}" and "${project.id}".`,
          configPath,
          projectId: project.id,
        });
      }

      aliases.set(alias, project.id);
    }
  }
}

export function validateUniqueWorktreeManagedRoots(
  projects: readonly ProjectConfig[],
  configPath: string,
): void {
  const managedRoots = new Map<string, string>();

  for (const project of projects) {
    const managedRoot = project.worktrunk.managedRoot;
    if (managedRoot === undefined) {
      continue;
    }

    const normalizedRoot = normalize(managedRoot);
    const previousProjectId = managedRoots.get(normalizedRoot);
    if (previousProjectId !== undefined) {
      throw new ConfigError({
        code: "CONFIG_DUPLICATE_WORKTREE_MANAGED_ROOT",
        message: `Projects "${previousProjectId}" and "${project.id}" resolve to the same Worktrunk managed root.`,
        configPath,
        projectId: project.id,
      });
    }

    managedRoots.set(normalizedRoot, project.id);
  }
}
