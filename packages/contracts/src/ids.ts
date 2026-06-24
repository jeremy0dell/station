import { z } from "zod";
import { nonEmptyStringSchema } from "./shared.js";

export const STATION_SCHEMA_VERSION = "0.5.0" as const;

const timestampSchema = z.string().datetime({ offset: true });
declare const stationIdKind: unique symbol;

export type StationId<TKind extends string> = string & {
  readonly [stationIdKind]?: TKind;
};

function idSchema<TKind extends string>(): z.ZodType<StationId<TKind>, string> {
  return nonEmptyStringSchema as z.ZodType<StationId<TKind>, string>;
}

export const SchemaVersionSchema = z.literal(STATION_SCHEMA_VERSION);

export const ProjectIdSchema = idSchema<"ProjectId">();
export const WorktreeIdSchema = idSchema<"WorktreeId">();
export const SessionIdSchema = idSchema<"SessionId">();
export const TerminalTargetIdSchema = idSchema<"TerminalTargetId">();
export const HarnessRunIdSchema = idSchema<"HarnessRunId">();
export const CommandIdSchema = idSchema<"CommandId">();
export const EventIdSchema = idSchema<"EventId">();
export const ProviderIdSchema = idSchema<"ProviderId">();
export const TimestampSchema = timestampSchema;

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type WorktreeId = z.infer<typeof WorktreeIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type TerminalTargetId = z.infer<typeof TerminalTargetIdSchema>;
export type HarnessRunId = z.infer<typeof HarnessRunIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
