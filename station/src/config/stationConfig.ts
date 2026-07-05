import {
  ConfigError,
  DEFAULT_WORKSPACE_CONFIG,
  loadConfig,
  resolveObserverPaths,
  type WorkspaceConfig,
} from "@station/config";
import { safeErrorFromUnknown } from "@station/runtime";

// Native Station workspace settings are the `[workspace]` section of the single
// runtime config (`~/.config/station/config.toml`). This module is a thin adapter
// that pulls that section out of the loaded config; the schema, defaults, and
// validation live in `@station/config`.
export {
  type Automation,
  type AutomationStep,
  DEFAULT_WORKSPACE_CONFIG,
  SCROLL_ON_OUTPUT_MODES,
  type ScrollOnOutputMode,
  type WorkspaceConfig,
} from "@station/config";

export type StationConfigSource = "file" | "defaults";

export type StationConfigLoadResult = {
  config: WorkspaceConfig;
  source: StationConfigSource;
  /** Runtime state dir (config-relocatable); TUI logs and pane dumps live under it. */
  stateDir: string;
  /** Set when a present-but-broken config forced a fallback to defaults. */
  warning?: string;
};

/**
 * Load the native `[workspace]` settings from the runtime config
 * (`~/.config/station/config.toml`, relocatable via `STATION_CONFIG_PATH`). A
 * missing config or a broken file degrades to defaults — never throws — so a bad
 * edit drops the TUI to default workspace behavior rather than refusing to start.
 * `[workspace]` is best-effort inside the config schema, so a typo in that section
 * alone already yields defaults plus a load diagnostic.
 */
export async function loadStationConfig(options?: {
  path?: string;
  env?: Record<string, string | undefined>;
}): Promise<StationConfigLoadResult> {
  const configPath = options?.path ?? configPathFromEnv(options?.env);
  try {
    const loaded = configPath === undefined ? await loadConfig() : await loadConfig({ configPath });
    const result: StationConfigLoadResult = {
      config: loaded.config.workspace,
      source: "file",
      stateDir: resolveObserverPaths(loaded.config).stateDir,
    };
    // The config loaded, but a typo'd [workspace] was best-effort dropped to
    // defaults — surface that as a warning rather than swallowing it silently.
    const sectionWarning = loaded.diagnostics.find(
      (diagnostic) => diagnostic.code === "CONFIG_WORKSPACE_SECTION_INVALID",
    );
    if (sectionWarning !== undefined) {
      result.warning = sectionWarning.message;
    }
    return result;
  } catch (cause) {
    // A missing config is the common first-run case: silent defaults.
    if (cause instanceof ConfigError && cause.code === "CONFIG_FILE_NOT_FOUND") {
      return {
        config: DEFAULT_WORKSPACE_CONFIG,
        source: "defaults",
        stateDir: resolveObserverPaths().stateDir,
      };
    }
    const error =
      cause instanceof ConfigError
        ? cause.toSafeError()
        : safeErrorFromUnknown(cause, {
            tag: "StationConfigError",
            code: "STATION_WORKSPACE_CONFIG_LOAD_FAILED",
            message: "Could not load STATION workspace config",
          });
    return {
      config: DEFAULT_WORKSPACE_CONFIG,
      source: "defaults",
      stateDir: resolveObserverPaths().stateDir,
      warning: `${error.message}; using defaults.`,
    };
  }
}

function configPathFromEnv(env: Record<string, string | undefined> | undefined): string | undefined {
  const value = env?.STATION_CONFIG_PATH?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
