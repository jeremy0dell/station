import { z } from "zod";

export const LogLevels = ["debug", "info", "warn", "error"] as const;
export const LogLevelSchema = z.enum(LogLevels);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogComponentSchema = z.enum([
  "observer",
  "cli",
  "tui",
  "hook",
  "provider",
  "station-host",
]);
