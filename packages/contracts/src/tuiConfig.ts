import { z } from "zod";
import { nonEmptyStringSchema } from "./shared.js";

/**
 * Shared `[tui]` configuration shapes. `@station/config` owns loading and
 * persisting config.toml and re-exports these schemas; dashboard-core depends
 * on the shapes only, through contracts, so its emitted declarations never
 * reference a package it does not declare.
 */

export const TuiTimeWidgetConfigSchema = z
  .object({
    type: z.literal("time"),
    enabled: z.boolean().optional(),
    timeFormat: z.enum(["12h", "24h"]).optional(),
  })
  .strict();

export type TuiTimeWidgetConfig = z.infer<typeof TuiTimeWidgetConfigSchema>;

export const TuiWeatherWidgetConfigSchema = z
  .object({
    type: z.literal("weather"),
    enabled: z.boolean().optional(),
    city: nonEmptyStringSchema,
    label: nonEmptyStringSchema.optional(),
    temperatureUnit: z.enum(["fahrenheit", "celsius"]).optional(),
    refreshIntervalMinutes: z.number().int().positive().optional(),
  })
  .strict();

export type TuiWeatherWidgetConfig = z.infer<typeof TuiWeatherWidgetConfigSchema>;

/** Live-agent count derived from the snapshot; no external data source. */
export const TuiFleetWidgetConfigSchema = z
  .object({
    type: z.literal("fleet"),
    enabled: z.boolean().optional(),
  })
  .strict();

/** Open-PR count derived from the snapshot; no external data source. */
export const TuiPrsWidgetConfigSchema = z
  .object({
    type: z.literal("prs"),
    enabled: z.boolean().optional(),
  })
  .strict();

export const TuiTimezoneZoneSchema = z
  .object({
    label: nonEmptyStringSchema,
    /** IANA zone name; an unknown zone renders as "--:--" rather than failing the section. */
    timeZone: nonEmptyStringSchema,
  })
  .strict();

export type TuiTimezoneZone = z.infer<typeof TuiTimezoneZoneSchema>;

export const TuiTimezoneWidgetConfigSchema = z
  .object({
    type: z.literal("tz"),
    enabled: z.boolean().optional(),
    zones: z.array(TuiTimezoneZoneSchema).min(1).max(2),
    timeFormat: z.enum(["12h", "24h"]).optional(),
  })
  .strict();

export type TuiTimezoneWidgetConfig = z.infer<typeof TuiTimezoneWidgetConfigSchema>;

export const TuiMoonWidgetConfigSchema = z
  .object({
    type: z.literal("moon"),
    enabled: z.boolean().optional(),
  })
  .strict();

export const TuiWidgetConfigSchema = z.discriminatedUnion("type", [
  TuiTimeWidgetConfigSchema,
  TuiWeatherWidgetConfigSchema,
  TuiFleetWidgetConfigSchema,
  TuiPrsWidgetConfigSchema,
  TuiTimezoneWidgetConfigSchema,
  TuiMoonWidgetConfigSchema,
]);

export type TuiWidgetConfig = z.infer<typeof TuiWidgetConfigSchema>;

export const TuiIslandConfigSchema = z
  .object({
    /** Collapsed island shows live fleet counts (working/ready/idle) instead of the bare mark. */
    restCounts: z.boolean().optional(),
    /** Hovered island lists each project's worst agent status instead of the totals summary. */
    projectRollup: z.boolean().optional(),
  })
  .strict();

export type TuiIslandConfig = z.infer<typeof TuiIslandConfigSchema>;

export const TuiConfigSchema = z
  .object({
    widgets: z.array(TuiWidgetConfigSchema).optional(),
    island: TuiIslandConfigSchema.optional(),
  })
  .strict();

export type TuiConfig = z.infer<typeof TuiConfigSchema>;
