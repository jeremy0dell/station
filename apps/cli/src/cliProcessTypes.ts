import type { LoadedStationConfig, ObserverPaths } from "@station/config";
import type { CreateJsonlLoggerOptions, JsonlLogger } from "@station/observability";

export type CliProcessDeps = {
  randomUUID?: () => string;
  clock?: { now(): Date };
  loadConfig?: (configPath?: string) => Promise<LoadedStationConfig>;
  resolveObserverPaths?: (config: LoadedStationConfig["config"] | undefined) => ObserverPaths;
  createLogger?: (options: CreateJsonlLoggerOptions) => JsonlLogger;
  stdoutWrite?: (value: string) => void;
  stderrWrite?: (value: string) => void;
  exit?: (code: number) => void;
  setExitCode?: (code: number) => void;
};
