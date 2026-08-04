import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { replaceTextFile } from "@station/runtime";
import { ConfigError } from "../load/errors.js";
import { loadConfigFromToml } from "../load/index.js";
import { DEFAULT_CONFIG_PATH, normalizeConfigPath } from "../load/paths.js";
import { projectConfigSafeError } from "./errors.js";
import type { LoadedConfigSource } from "./types.js";

export async function loadConfigSource(options: {
  configPath?: string;
  homeDir?: string;
}): Promise<LoadedConfigSource> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = normalizeConfigPath(options.configPath ?? DEFAULT_CONFIG_PATH, homeDir);
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (cause) {
    throw new ConfigError({
      code: "CONFIG_FILE_READ_FAILED",
      message: "Station config file could not be read.",
      configPath,
      cause,
    });
  }
  const loaded = await loadConfigFromToml(source, { configPath, homeDir });
  return { configPath, homeDir, source, loaded };
}

export async function atomicWriteConfig(configPath: string, source: string): Promise<void> {
  try {
    await replaceTextFile({
      path: configPath,
      contents: source,
      mode: 0o600,
      directoryMode: 0o700,
    });
  } catch (cause) {
    throw projectConfigSafeError({
      code: "CONFIG_WRITE_FAILED",
      message: "Could not update config.toml.",
      hint: configPath,
      cause,
    });
  }
}
