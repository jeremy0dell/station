export const commonPiCompactFieldNames = [
  "event_type",
  "cwd",
  "pid",
  "pi_session_id",
  "pi_session_file",
  "model",
  "station_project_id",
  "station_worktree_id",
  "station_worktree_path",
  "station_session_id",
  "station_terminal_provider",
  "station_terminal_target_id",
  "station_extension_protocol",
] as const;

/** Pi lifecycle events emitted natively through the extension `pi.on` API. */
export const piNativeEventNames = [
  "session_start",
  "session_shutdown",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "tool_execution_start",
  "tool_execution_end",
  "message_end",
  "session_compact",
] as const;

export type PiNativeEventName = (typeof piNativeEventNames)[number];

/**
 * Low-cardinality provider-boundary allowlist for native and Station-derived Pi
 * events that carry status or lifecycle signal.
 */
export const piSupportedEventNames = [...piNativeEventNames, "question_prompt_open"] as const;

export type PiSupportedEventName = (typeof piSupportedEventNames)[number];

const piEventDescriptorDefinitions = {
  session_start: {
    compactFieldNames: ["reason", "previous_session_file"],
  },
  session_shutdown: {
    compactFieldNames: ["reason", "target_session_file"],
  },
  agent_start: {
    compactFieldNames: [],
  },
  agent_end: {
    compactFieldNames: ["message_count"],
  },
  agent_settled: {
    compactFieldNames: [],
  },
  turn_start: {
    compactFieldNames: ["turn_index"],
  },
  tool_execution_start: {
    compactFieldNames: ["tool_call_id", "tool_name", "active_question_call_id"],
  },
  tool_execution_end: {
    compactFieldNames: ["tool_call_id", "tool_name", "is_error", "active_question_call_id"],
  },
  question_prompt_open: {
    compactFieldNames: ["tool_call_id", "tool_name"],
  },
  message_end: {
    compactFieldNames: ["message_role"],
  },
  session_compact: {
    compactFieldNames: ["from_extension", "compaction_entry_id", "reason", "will_retry"],
  },
} as const satisfies Record<PiSupportedEventName, { compactFieldNames: readonly string[] }>;

export function compactFieldNamesForPiEvent(eventType: PiSupportedEventName): string[] {
  return [
    ...commonPiCompactFieldNames,
    ...piEventDescriptorDefinitions[eventType].compactFieldNames,
  ];
}
