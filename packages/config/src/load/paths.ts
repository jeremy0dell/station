import { isAbsolute, join, resolve } from "node:path";
import type { ProjectConfig } from "../schema.js";

export const DEFAULT_CONFIG_PATH = "~/.config/station/config.toml";

export function normalizeConfigPath(configPath: string, homeDir: string): string {
  return resolveConfigPath(configPath, homeDir, process.cwd());
}

export function resolveConfigPath(input: string, homeDir: string, baseDir: string): string {
  const expanded = expandLeadingHome(input, homeDir);

  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }

  return resolve(baseDir, expanded);
}

export function resolveProjectLocalConfigPath(
  project: ProjectConfig,
  homeDir: string,
): ProjectConfig {
  if (project.localConfig === undefined) {
    return project;
  }

  const path = project.localConfig.path.startsWith("~/")
    ? resolveConfigPath(project.localConfig.path, homeDir, project.root)
    : resolve(project.root, project.localConfig.path);

  return {
    ...project,
    localConfig: {
      ...project.localConfig,
      path,
    },
  };
}

function expandLeadingHome(input: string, homeDir: string): string {
  if (input === "~") {
    return homeDir;
  }

  if (input.startsWith("~/")) {
    return join(homeDir, input.slice(2));
  }

  return input;
}
