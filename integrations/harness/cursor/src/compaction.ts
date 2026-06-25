import { compactPayloadByFieldNames, type PayloadCompactionResult } from "@station/harness-shared";

export type CursorProviderHookPayloadCompactionResult = {
  payload: unknown;
  compacted: boolean;
  originalByteCount: number | null;
  compactedByteCount: number | null;
  omittedFieldNames: string[];
};

const retainedFieldNames = [
  "hook_event_name",
  "session_id",
  "conversation_id",
  "generation_id",
  "transcript_path",
  "cwd",
  "workspace_roots",
  "model",
  "cursor_version",
  "status",
  "tool_name",
  "tool_use_id",
  "request_id",
  "message_id",
  "station_project_id",
  "station_worktree_id",
  "station_worktree_path",
  "station_session_id",
  "station_terminal_provider",
  "station_terminal_target_id",
] as const;

export function compactCursorProviderHookPayload(
  payload: unknown,
): CursorProviderHookPayloadCompactionResult {
  return compactPayloadByFieldNames(payload, {
    retainedFieldNames,
  }) satisfies PayloadCompactionResult;
}
