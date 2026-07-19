// Zod schemas for Pi's compact event payloads (provider boundary).
// Contract: STATION-native (first-party Pi harness, no external upstream) — see packages/contracts.
// STATION ingress flow: docs/harness-ingress.md.
import { z } from "zod";
import { piHarnessError } from "../errors.js";
import { type PiSupportedEventName, piSupportedEventNames } from "./names.js";

const nonEmptyStringSchema = z.string().min(1);
const optionalModelSummarySchema = z
  .object({
    provider: nonEmptyStringSchema.optional(),
    id: nonEmptyStringSchema.optional(),
    name: nonEmptyStringSchema.optional(),
  })
  .strict();

const commonFields = {
  event_type: z.enum(piSupportedEventNames),
  cwd: nonEmptyStringSchema,
  pid: z.number().int().positive().optional(),
  pi_session_id: nonEmptyStringSchema.optional(),
  pi_session_file: nonEmptyStringSchema.optional(),
  model: optionalModelSummarySchema.optional(),
  station_project_id: nonEmptyStringSchema.optional(),
  station_worktree_id: nonEmptyStringSchema.optional(),
  station_worktree_path: nonEmptyStringSchema.optional(),
  station_session_id: nonEmptyStringSchema.optional(),
  station_terminal_provider: nonEmptyStringSchema.optional(),
  station_terminal_target_id: nonEmptyStringSchema.optional(),
  station_extension_protocol: z.literal(2).optional(),
};

const SessionStartEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("session_start"),
    reason: z.enum(["startup", "reload", "new", "resume", "fork"]).optional(),
    previous_session_file: nonEmptyStringSchema.optional(),
  })
  .strict();

const SessionShutdownEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("session_shutdown"),
    reason: z.enum(["quit", "reload", "new", "resume", "fork"]).optional(),
    target_session_file: nonEmptyStringSchema.optional(),
  })
  .strict();

const AgentStartEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("agent_start"),
  })
  .strict();

const AgentEndEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("agent_end"),
    message_count: z.number().int().nonnegative().optional(),
  })
  .strict();

const AgentSettledEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("agent_settled"),
  })
  .strict();

const TurnStartEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("turn_start"),
    turn_index: z.number().int().nonnegative().optional(),
  })
  .strict();

const ToolExecutionStartEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("tool_execution_start"),
    tool_call_id: nonEmptyStringSchema.optional(),
    tool_name: nonEmptyStringSchema.optional(),
    active_question_call_id: nonEmptyStringSchema.optional(),
  })
  .strict();

const ToolExecutionEndEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("tool_execution_end"),
    tool_call_id: nonEmptyStringSchema.optional(),
    tool_name: nonEmptyStringSchema.optional(),
    is_error: z.boolean().optional(),
    active_question_call_id: nonEmptyStringSchema.optional(),
  })
  .strict();

const QuestionPromptOpenEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("question_prompt_open"),
    tool_call_id: nonEmptyStringSchema,
    tool_name: z.literal("ask_user_question"),
  })
  .strict();

const MessageEndEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("message_end"),
    message_role: z.enum(["user", "assistant", "tool", "toolResult", "system"]).optional(),
  })
  .strict();

const SessionCompactEventSchema = z
  .object({
    ...commonFields,
    event_type: z.literal("session_compact"),
    from_extension: z.boolean().optional(),
    compaction_entry_id: nonEmptyStringSchema.optional(),
    reason: z.enum(["manual", "threshold", "overflow"]).optional(),
    will_retry: z.boolean().optional(),
  })
  .strict();

export const PiSupportedEventNameSchema = z.enum(piSupportedEventNames);

const piCompactEventSchemaByName = {
  session_start: SessionStartEventSchema,
  session_shutdown: SessionShutdownEventSchema,
  agent_start: AgentStartEventSchema,
  agent_end: AgentEndEventSchema,
  agent_settled: AgentSettledEventSchema,
  turn_start: TurnStartEventSchema,
  tool_execution_start: ToolExecutionStartEventSchema,
  tool_execution_end: ToolExecutionEndEventSchema,
  question_prompt_open: QuestionPromptOpenEventSchema,
  message_end: MessageEndEventSchema,
  session_compact: SessionCompactEventSchema,
} satisfies Record<PiSupportedEventName, z.ZodType>;

export const PiCompactEventSchema = z.discriminatedUnion(
  "event_type",
  piSupportedEventNames.map((eventType) => piCompactEventSchemaByName[eventType]) as [
    typeof SessionStartEventSchema,
    typeof SessionShutdownEventSchema,
    typeof AgentStartEventSchema,
    typeof AgentEndEventSchema,
    typeof AgentSettledEventSchema,
    typeof TurnStartEventSchema,
    typeof ToolExecutionStartEventSchema,
    typeof ToolExecutionEndEventSchema,
    typeof QuestionPromptOpenEventSchema,
    typeof MessageEndEventSchema,
    typeof SessionCompactEventSchema,
  ],
);

export type PiCompactEvent = z.infer<typeof PiCompactEventSchema>;

export function parsePiCompactEvent(input: unknown): PiCompactEvent {
  const result = PiCompactEventSchema.safeParse(input);
  if (!result.success) {
    throw piHarnessError(
      "HARNESS_PI_EVENT_INVALID",
      "Pi event payload did not match the supported compact strict schema.",
      result.error,
    );
  }
  return result.data;
}

export function normalizePiEventType(input: string): PiSupportedEventName {
  const value = input.trim();
  const result = PiSupportedEventNameSchema.safeParse(value);
  if (!result.success) {
    throw piHarnessError(
      "HARNESS_PI_EVENT_INVALID",
      `Unsupported Pi event type: ${input}.`,
      result.error,
    );
  }
  return result.data;
}
