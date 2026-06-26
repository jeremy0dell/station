import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { TuiConfigSchema, WorkspaceConfigSchema } from "../schema.js";
import { isNodeError, isRecord } from "./common.js";
import { deriveProjectConfig } from "./deriveProjects.js";
import type {
  ConfigDiagnostic,
  LoadConfigFromTomlOptions,
  LoadConfigOptions,
  LoadedStationConfig,
} from "./errors.js";
import { ConfigError } from "./errors.js";
import { applyProjectLocalConfigs } from "./localConfig.js";
import { normalizeGlobalConfig } from "./normalize.js";
import { parseGlobalConfig, parseStationConfig } from "./parseToml.js";
import {
  DEFAULT_CONFIG_PATH,
  normalizeConfigPath,
  resolveProjectLocalConfigPath,
} from "./paths.js";
import {
  validateProjectIdentifiers,
  validateProjectRoots,
  validateUniqueWorktreeManagedRoots,
} from "./validate.js";

export type {
  ConfigDiagnostic,
  ConfigDiagnosticCode,
  ConfigErrorCode,
  ConfigErrorOptions,
  LoadConfigFromTomlOptions,
  LoadConfigOptions,
  LoadedStationConfig,
} from "./errors.js";
export { ConfigError } from "./errors.js";
export { DEFAULT_CONFIG_PATH } from "./paths.js";

export async function loadConfig(configPath: string): Promise<LoadedStationConfig>;
export async function loadConfig(options?: LoadConfigOptions): Promise<LoadedStationConfig>;
export async function loadConfig(
  input: string | LoadConfigOptions = {},
): Promise<LoadedStationConfig> {
  const options = typeof input === "string" ? { configPath: input } : input;
  const home = options.homeDir ?? homedir();
  const configPath = normalizeConfigPath(options.configPath ?? DEFAULT_CONFIG_PATH, home);

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (cause) {
    throw new ConfigError({
      code:
        isNodeError(cause) && cause.code === "ENOENT"
          ? "CONFIG_FILE_NOT_FOUND"
          : "CONFIG_FILE_READ_FAILED",
      message:
        isNodeError(cause) && cause.code === "ENOENT"
          ? "Station config file was not found."
          : "Station config file could not be read.",
      configPath,
      cause,
    });
  }

  return loadConfigFromToml(source, { configPath, homeDir: home });
}

export async function loadConfigFromToml(
  source: string,
  options: LoadConfigFromTomlOptions = {},
): Promise<LoadedStationConfig> {
  const home = options.homeDir ?? homedir();
  const configPath = normalizeConfigPath(options.configPath ?? DEFAULT_CONFIG_PATH, home);
  const configDir = dirname(configPath);
  const rawConfig = parseGlobalConfig(source, configPath);
  const normalizedConfig = normalizeGlobalConfig(rawConfig);
  const sectionDiagnostics = collectTuiWorkspaceDiagnostics(normalizedConfig, configPath);
  const derivedConfig = deriveProjectConfig(normalizedConfig, {
    configPath,
    configDir,
    homeDir: home,
  });
  const parsedConfig = parseStationConfig(derivedConfig, configPath);

  validateProjectIdentifiers(parsedConfig.projects, configPath);
  validateUniqueWorktreeManagedRoots(parsedConfig.projects, configPath);
  await validateProjectRoots(parsedConfig.projects, configPath);

  const configWithResolvedLocalPaths = {
    ...parsedConfig,
    projects: parsedConfig.projects.map((project) => resolveProjectLocalConfigPath(project, home)),
  };
  const localConfigResult = await applyProjectLocalConfigs(configWithResolvedLocalPaths, home);
  const config = parseStationConfig(localConfigResult.config, configPath);

  return {
    configPath,
    config,
    projects: config.projects,
    diagnostics: [...sectionDiagnostics, ...localConfigResult.diagnostics],
  };
}

/**
 * The TUI-only `[tui]`/`[workspace]` sections are best-effort in the schema
 * (`.catch` → defaults) so a cosmetic typo never aborts the daemon's load. That
 * silent fallback would otherwise hide the mistake, so surface it as a warn-level
 * diagnostic (visible via `stn doctor`). Validated against the same strict
 * schemas the runtime config uses for these sections.
 */
function collectTuiWorkspaceDiagnostics(
  normalizedConfig: unknown,
  configPath: string,
): ConfigDiagnostic[] {
  if (!isRecord(normalizedConfig)) {
    return [];
  }

  const diagnostics: ConfigDiagnostic[] = [];

  if (
    normalizedConfig.tui !== undefined &&
    !TuiConfigSchema.safeParse(normalizedConfig.tui).success
  ) {
    diagnostics.push({
      tag: "ConfigDiagnostic",
      code: "CONFIG_TUI_SECTION_INVALID",
      message: "The [tui] section is invalid and was ignored; using widget defaults.",
      severity: "warn",
      configPath,
    });
  }

  if (
    normalizedConfig.workspace !== undefined &&
    !WorkspaceConfigSchema.safeParse(normalizedConfig.workspace).success
  ) {
    diagnostics.push({
      tag: "ConfigDiagnostic",
      code: "CONFIG_WORKSPACE_SECTION_INVALID",
      message: "The [workspace] section is invalid and was ignored; using workspace defaults.",
      severity: "warn",
      configPath,
    });
  }

  return diagnostics;
}
