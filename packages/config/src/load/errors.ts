import type { SafeError } from "@station/contracts";
import type { z } from "zod";
import type { ProjectConfig, StationConfig } from "../schema.js";
import { formatZodError } from "./common.js";

export type ConfigErrorCode =
  | "CONFIG_FILE_NOT_FOUND"
  | "CONFIG_FILE_READ_FAILED"
  | "CONFIG_TOML_PARSE_FAILED"
  | "CONFIG_VALIDATION_FAILED"
  | "CONFIG_DUPLICATE_PROJECT_ID"
  | "CONFIG_DUPLICATE_ALIAS"
  | "CONFIG_ALIAS_PROJECT_ID_COLLISION"
  | "CONFIG_DUPLICATE_WORKTREE_MANAGED_ROOT"
  | "CONFIG_INVALID_PROJECT_ROOT";

export type ConfigDiagnosticCode =
  | "CONFIG_LOCAL_CONFIG_NOT_FOUND"
  | "CONFIG_LOCAL_CONFIG_READ_FAILED"
  | "CONFIG_LOCAL_CONFIG_PARSE_FAILED"
  | "CONFIG_LOCAL_CONFIG_INVALID"
  | "CONFIG_LOCAL_COMMAND_OVERRIDE";

export interface ConfigErrorOptions {
  code: ConfigErrorCode;
  message: string;
  configPath: string;
  projectId?: string;
  cause?: unknown;
}

export class ConfigError extends Error {
  readonly tag = "ConfigError" as const;
  readonly code: ConfigErrorCode;
  readonly configPath: string;
  readonly projectId?: string;

  constructor(options: ConfigErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = this.tag;
    this.code = options.code;
    this.configPath = options.configPath;

    if (options.projectId !== undefined) {
      this.projectId = options.projectId;
    }
  }

  toSafeError(): SafeError {
    const safeError: SafeError = {
      tag: this.tag,
      code: this.code,
      message: this.message,
    };

    if (this.projectId !== undefined) {
      safeError.projectId = this.projectId;
    }

    return safeError;
  }
}

export interface ConfigDiagnostic {
  tag: "ConfigDiagnostic";
  code: ConfigDiagnosticCode;
  message: string;
  severity: "warn" | "error";
  configPath: string;
  projectId?: string;
}

export interface LoadedStationConfig {
  configPath: string;
  config: StationConfig;
  projects: ProjectConfig[];
  diagnostics: ConfigDiagnostic[];
}

export interface LoadConfigOptions {
  configPath?: string;
  homeDir?: string;
}

export interface LoadConfigFromTomlOptions extends LoadConfigOptions {}

export function validationError(
  configPath: string,
  error: z.ZodError,
  projectId?: string,
): ConfigError {
  const options: ConfigErrorOptions = {
    code: "CONFIG_VALIDATION_FAILED",
    message: `Station config is invalid: ${formatZodError(error)}.`,
    configPath,
    cause: error,
  };

  if (projectId !== undefined) {
    options.projectId = projectId;
  }

  return new ConfigError({
    ...options,
  });
}

export function configDiagnostic(options: {
  code: ConfigDiagnosticCode;
  message: string;
  configPath: string;
  projectId: string;
}): ConfigDiagnostic {
  return {
    tag: "ConfigDiagnostic",
    code: options.code,
    message: options.message,
    severity: "error",
    configPath: options.configPath,
    projectId: options.projectId,
  };
}
