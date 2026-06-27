import { ConfigError, loadConfig, type TuiConfig } from "@station/config";
import { safeErrorFromUnknown } from "@station/runtime";

export type StationTuiConfigLoadResult = {
  config?: TuiConfig;
  warning?: string;
};

export async function loadStationTuiConfig(options?: {
  env?: Record<string, string | undefined>;
  path?: string;
}): Promise<StationTuiConfigLoadResult> {
  const configPath = options?.path ?? configPathFromEnv(options?.env);
  try {
    const loaded =
      configPath === undefined ? await loadConfig() : await loadConfig({ configPath });
    const result: StationTuiConfigLoadResult = {};
    if (loaded.config.tui !== undefined) {
      result.config = loaded.config.tui;
    }
    const sectionWarning = loaded.diagnostics.find(
      (diagnostic) => diagnostic.code === "CONFIG_TUI_SECTION_INVALID",
    );
    if (sectionWarning !== undefined) {
      result.warning = sectionWarning.message;
    }
    return result;
  } catch (cause) {
    if (cause instanceof ConfigError && cause.code === "CONFIG_FILE_NOT_FOUND") {
      return {};
    }
    const error =
      cause instanceof ConfigError
        ? cause.toSafeError()
        : safeErrorFromUnknown(cause, {
            tag: "StationConfigError",
            code: "STATION_TUI_CONFIG_LOAD_FAILED",
            message: "Could not load STATION TUI widget config",
          });
    return {
      warning: `${error.message}; widgets disabled.`,
    };
  }
}

function configPathFromEnv(env: Record<string, string | undefined> | undefined): string | undefined {
  const value = env?.STATION_CONFIG_PATH?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
