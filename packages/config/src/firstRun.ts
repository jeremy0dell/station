import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "./schema.js";

// First-run boot must not imply external provider readiness; the UI launch mode owns native/tmux.
export function emptyConfig(): StationConfig {
  return {
    schemaVersion: 1,
    defaults: {
      worktreeProvider: "noop-worktree",
      terminal: "noop-terminal",
      harness: "noop-harness",
      layout: "agent-shell",
    },
    workspace: DEFAULT_WORKSPACE_CONFIG,
    projects: [],
  };
}
