import { parse } from "smol-toml";
import type { StationConfig } from "../schema.js";
import { StationConfigSchema } from "../schema.js";
import { ConfigError, validationError } from "./errors.js";

export function parseGlobalConfig(source: string, configPath: string): unknown {
  try {
    return parse(source);
  } catch (cause) {
    throw new ConfigError({
      code: "CONFIG_TOML_PARSE_FAILED",
      message: "Station config file is not valid TOML.",
      configPath,
      cause,
    });
  }
}

export function parseStationConfig(value: unknown, configPath: string): StationConfig {
  const result = StationConfigSchema.safeParse(value);

  if (!result.success) {
    throw validationError(configPath, result.error);
  }

  return result.data;
}
