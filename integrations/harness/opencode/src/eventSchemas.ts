// Zod schemas for OpenCode native plugin-event payloads (provider boundary).
// Upstream contract: https://opencode.ai/docs/plugins/
// STATION ingress flow: docs/harness-ingress.md. Keep these schemas aligned with upstream's payload shape.
import { z } from "zod";

const nonEmptyStringSchema = z.string().min(1);

export const OpenCodeEventTypeSchema = nonEmptyStringSchema
  .transform((value) => value.trim())
  .pipe(nonEmptyStringSchema);

const OpenCodeNativeStatusSchema = z.union([
  nonEmptyStringSchema,
  z
    .object({
      type: nonEmptyStringSchema,
    })
    .passthrough(),
]);

const OpenCodeNativeToolRefSchema = z
  .object({
    messageID: nonEmptyStringSchema.optional(),
    callID: nonEmptyStringSchema.optional(),
  })
  .passthrough();

const OpenCodeNativeInfoSchema = z
  .object({
    id: nonEmptyStringSchema.optional(),
  })
  .passthrough();

const OpenCodeNativeErrorSchema = z
  .object({
    name: nonEmptyStringSchema.optional(),
  })
  .passthrough();

export const OpenCodeNativeEventPropertiesSchema = z
  .object({
    sessionID: nonEmptyStringSchema.optional(),
    sessionId: nonEmptyStringSchema.optional(),
    cwd: nonEmptyStringSchema.optional(),
    directory: nonEmptyStringSchema.optional(),
    status: OpenCodeNativeStatusSchema.optional(),
    reply: nonEmptyStringSchema.optional(),
    answers: z.array(z.unknown()).optional(),
    requestID: nonEmptyStringSchema.optional(),
    id: nonEmptyStringSchema.optional(),
    messageID: nonEmptyStringSchema.optional(),
    partID: nonEmptyStringSchema.optional(),
    callID: nonEmptyStringSchema.optional(),
    tool: z.union([nonEmptyStringSchema, OpenCodeNativeToolRefSchema]).optional(),
    name: nonEmptyStringSchema.optional(),
    permission: nonEmptyStringSchema.optional(),
    command: nonEmptyStringSchema.optional(),
    file: nonEmptyStringSchema.optional(),
    path: nonEmptyStringSchema.optional(),
    error: OpenCodeNativeErrorSchema.optional(),
    info: OpenCodeNativeInfoSchema.optional(),
  })
  .catchall(z.unknown());

export type OpenCodeNativeEventProperties = z.infer<typeof OpenCodeNativeEventPropertiesSchema>;

export const OpenCodeNativeEventSchema = z
  .object({
    id: nonEmptyStringSchema.optional(),
    type: OpenCodeEventTypeSchema,
    cwd: nonEmptyStringSchema.optional(),
    directory: nonEmptyStringSchema.optional(),
    pid: z.number().int().positive().optional(),
    properties: OpenCodeNativeEventPropertiesSchema.optional(),
  })
  .passthrough();

export type OpenCodeNativeEvent = z.infer<typeof OpenCodeNativeEventSchema>;

export const OpenCodeCompactEventSchema = z
  .object({
    event_type: OpenCodeEventTypeSchema,
    observed_at: nonEmptyStringSchema.optional(),
    event_id: nonEmptyStringSchema.optional(),
    cwd: nonEmptyStringSchema,
    pid: z.number().int().positive().optional(),
    opencode_session_id: nonEmptyStringSchema.optional(),
    status_type: nonEmptyStringSchema.optional(),
    permission_reply: nonEmptyStringSchema.optional(),
    question_reply: nonEmptyStringSchema.optional(),
    request_id: nonEmptyStringSchema.optional(),
    message_id: nonEmptyStringSchema.optional(),
    part_id: nonEmptyStringSchema.optional(),
    tool_call_id: nonEmptyStringSchema.optional(),
    tool_name: nonEmptyStringSchema.optional(),
    command_name: nonEmptyStringSchema.optional(),
    file_path: nonEmptyStringSchema.optional(),
    error_name: nonEmptyStringSchema.optional(),
    property_keys: z.array(nonEmptyStringSchema).max(128).optional(),
    station_project_id: nonEmptyStringSchema.optional(),
    station_worktree_id: nonEmptyStringSchema.optional(),
    station_worktree_path: nonEmptyStringSchema.optional(),
    station_session_id: nonEmptyStringSchema.optional(),
    station_terminal_provider: nonEmptyStringSchema.optional(),
    station_terminal_target_id: nonEmptyStringSchema.optional(),
    station_integration_id: nonEmptyStringSchema.optional(),
    station_integration_version: nonEmptyStringSchema.optional(),
  })
  .strict();

export type OpenCodeCompactEvent = z.infer<typeof OpenCodeCompactEventSchema>;

export const openCodeCompactFieldNames = [
  "event_type",
  "observed_at",
  "event_id",
  "cwd",
  "pid",
  "opencode_session_id",
  "status_type",
  "permission_reply",
  "question_reply",
  "request_id",
  "message_id",
  "part_id",
  "tool_call_id",
  "tool_name",
  "command_name",
  "file_path",
  "error_name",
  "property_keys",
  "station_project_id",
  "station_worktree_id",
  "station_worktree_path",
  "station_session_id",
  "station_terminal_provider",
  "station_terminal_target_id",
  "station_integration_id",
  "station_integration_version",
] as const;
