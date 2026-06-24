export type CodexHookScopeContext = {
  cwd?: string;
  stationProjectId?: string;
  stationWorktreeId?: string;
  stationWorktreePath?: string;
  stationSessionId?: string;
  stationTerminalProvider?: string;
  stationTerminalTargetId?: string;
};

export function extractCodexHookScopeContext(payload: unknown): CodexHookScopeContext {
  const context: CodexHookScopeContext = {};
  if (!isRecord(payload)) {
    return context;
  }

  assignStringField(context, "cwd", payload.cwd);
  assignStringField(context, "stationProjectId", payload.station_project_id);
  assignStringField(context, "stationWorktreeId", payload.station_worktree_id);
  assignStringField(context, "stationWorktreePath", payload.station_worktree_path);
  assignStringField(context, "stationSessionId", payload.station_session_id);
  assignStringField(context, "stationTerminalProvider", payload.station_terminal_provider);
  assignStringField(context, "stationTerminalTargetId", payload.station_terminal_target_id);
  return context;
}

function assignStringField(
  target: CodexHookScopeContext,
  key: keyof CodexHookScopeContext,
  value: unknown,
) {
  if (typeof value !== "string" || value.length === 0) {
    return;
  }
  target[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
