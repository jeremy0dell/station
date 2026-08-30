import type { StationConfig } from "@station/config";

export type GroupCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};
