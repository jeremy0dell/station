import type { StationConfig } from "@station/config";
import type { CliCommandRunContext } from "./types.js";

export type LoadedCommandOptions = {
  config?: StationConfig;
  configPath?: string;
};

export function loadedCommandOptions(context: CliCommandRunContext): LoadedCommandOptions {
  const options: LoadedCommandOptions = {};
  if (context.config !== undefined) {
    options.config = context.config;
  }
  if (context.resolvedConfigPath !== undefined) {
    options.configPath = context.resolvedConfigPath;
  }
  return options;
}

export function hookCommandExitCode(result: object): number {
  return "status" in result && result.status === "warn" ? 1 : 0;
}

export function actionNeedsYes(action: string): boolean {
  return action === "install" || action === "uninstall";
}

export function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
