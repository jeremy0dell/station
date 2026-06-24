import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import type { ProjectConfig, ProjectLocalConfig, StationConfig } from "../schema.js";
import { ProjectLocalConfigSchema } from "../schema.js";
import { isNodeError } from "./common.js";
import type { ConfigDiagnostic } from "./errors.js";
import { configDiagnostic } from "./errors.js";
import { normalizeProjectLocalConfig } from "./normalize.js";
import { resolveProjectLocalConfigPath } from "./paths.js";

export async function applyProjectLocalConfigs(
  config: StationConfig,
  homeDir: string,
): Promise<{ config: StationConfig; diagnostics: ConfigDiagnostic[] }> {
  const diagnostics: ConfigDiagnostic[] = [];
  const projects: ProjectConfig[] = [];

  for (const project of config.projects) {
    if (project.localConfig?.enabled !== true) {
      projects.push(project);
      continue;
    }

    const localConfigPath = project.localConfig.path;
    const localSource = await readProjectLocalConfig(localConfigPath, project, diagnostics);

    if (localSource === undefined) {
      projects.push(project);
      continue;
    }

    const localConfig = parseProjectLocalConfig(localSource, localConfigPath, project, diagnostics);

    if (localConfig === undefined) {
      projects.push(project);
      continue;
    }

    projects.push(mergeProjectLocalConfig(project, localConfig, localConfigPath, diagnostics));
  }

  return {
    config: {
      ...config,
      projects: projects.map((project) => resolveProjectLocalConfigPath(project, homeDir)),
    },
    diagnostics,
  };
}

async function readProjectLocalConfig(
  localConfigPath: string,
  project: ProjectConfig,
  diagnostics: ConfigDiagnostic[],
): Promise<string | undefined> {
  try {
    return await readFile(localConfigPath, "utf8");
  } catch (cause) {
    diagnostics.push(
      configDiagnostic({
        code:
          isNodeError(cause) && cause.code === "ENOENT"
            ? "CONFIG_LOCAL_CONFIG_NOT_FOUND"
            : "CONFIG_LOCAL_CONFIG_READ_FAILED",
        message:
          isNodeError(cause) && cause.code === "ENOENT"
            ? `Project "${project.id}" local config was not found.`
            : `Project "${project.id}" local config could not be read.`,
        configPath: localConfigPath,
        projectId: project.id,
      }),
    );
    return undefined;
  }
}

function parseProjectLocalConfig(
  source: string,
  localConfigPath: string,
  project: ProjectConfig,
  diagnostics: ConfigDiagnostic[],
): ProjectLocalConfig | undefined {
  let rawLocalConfig: unknown;

  try {
    rawLocalConfig = parse(source);
  } catch {
    diagnostics.push(
      configDiagnostic({
        code: "CONFIG_LOCAL_CONFIG_PARSE_FAILED",
        message: `Project "${project.id}" local config is not valid TOML.`,
        configPath: localConfigPath,
        projectId: project.id,
      }),
    );
    return undefined;
  }

  const result = ProjectLocalConfigSchema.safeParse(normalizeProjectLocalConfig(rawLocalConfig));

  if (!result.success) {
    diagnostics.push(
      configDiagnostic({
        code: "CONFIG_LOCAL_CONFIG_INVALID",
        message: `Project "${project.id}" local config contains unsupported or invalid fields.`,
        configPath: localConfigPath,
        projectId: project.id,
      }),
    );
    return undefined;
  }

  return result.data;
}

function mergeProjectLocalConfig(
  project: ProjectConfig,
  localConfig: ProjectLocalConfig,
  localConfigPath: string,
  diagnostics: ConfigDiagnostic[],
): ProjectConfig {
  const commands = mergeProjectLocalCommands(project, localConfig, localConfigPath, diagnostics);
  const defaults = mergeProjectLocalDefaults(project, localConfig);
  const display =
    localConfig.display === undefined
      ? project.display
      : {
          ...project.display,
          ...localConfig.display,
        };

  return {
    ...project,
    defaults,
    ...(commands === undefined ? {} : { commands }),
    ...(display === undefined ? {} : { display }),
  };
}

function mergeProjectLocalDefaults(
  project: ProjectConfig,
  localConfig: ProjectLocalConfig,
): ProjectConfig["defaults"] {
  return {
    ...project.defaults,
    ...(localConfig.defaults?.harness === undefined
      ? {}
      : { harness: localConfig.defaults.harness }),
    ...(localConfig.defaults?.layout === undefined ? {} : { layout: localConfig.defaults.layout }),
  };
}

function mergeProjectLocalCommands(
  project: ProjectConfig,
  localConfig: ProjectLocalConfig,
  localConfigPath: string,
  diagnostics: ConfigDiagnostic[],
): Record<string, string> | undefined {
  const projectCommands = project.commands ?? {};
  const localCommands = localConfig.commands ?? {};
  const mergedCommands = { ...projectCommands };

  for (const [commandLabel, command] of Object.entries(localCommands)) {
    if (Object.hasOwn(projectCommands, commandLabel)) {
      diagnostics.push(
        configDiagnostic({
          code: "CONFIG_LOCAL_COMMAND_OVERRIDE",
          message: `Project "${project.id}" local config cannot override command "${commandLabel}".`,
          configPath: localConfigPath,
          projectId: project.id,
        }),
      );
      continue;
    }

    mergedCommands[commandLabel] = command;
  }

  return Object.keys(mergedCommands).length > 0 ? mergedCommands : undefined;
}
