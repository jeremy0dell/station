import { z } from "zod";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogComponentSchema = z.enum([
  "observer",
  "cli",
  "tui",
  "hook",
  "provider",
  "station-host",
]);
export type LogComponent = z.infer<typeof LogComponentSchema>;
