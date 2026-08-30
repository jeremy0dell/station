import { z } from "zod";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const LogComponentSchema = z.enum([
  "observer",
  "cli",
  "tui",
  "hook",
  "provider",
  "station-host",
]);
