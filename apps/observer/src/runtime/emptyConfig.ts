import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";

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
