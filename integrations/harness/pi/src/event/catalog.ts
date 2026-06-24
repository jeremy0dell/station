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
] as const;

export const piSupportedEventNames = [
  "session_start",
  "session_shutdown",
  "agent_start",
  "agent_end",
  "turn_start",
  "tool_execution_start",
  "tool_execution_end",
  "message_end",
  "session_compact",
] as const;

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
  turn_start: {
    compactFieldNames: ["turn_index"],
  },
  tool_execution_start: {
    compactFieldNames: ["tool_call_id", "tool_name"],
  },
  tool_execution_end: {
    compactFieldNames: ["tool_call_id", "tool_name", "is_error"],
  },
  message_end: {
    compactFieldNames: ["message_role"],
  },
  session_compact: {
    compactFieldNames: ["from_extension", "compaction_entry_id"],
  },
} as const satisfies Record<PiSupportedEventName, { compactFieldNames: readonly string[] }>;

export function compactFieldNamesForPiEvent(eventType: PiSupportedEventName): string[] {
  return [
    ...commonPiCompactFieldNames,
    ...piEventDescriptorDefinitions[eventType].compactFieldNames,
  ];
}
