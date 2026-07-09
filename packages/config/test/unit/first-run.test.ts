import { DEFAULT_WORKSPACE_CONFIG, emptyConfig } from "@station/config";
import { describe, expect, it } from "vitest";

describe("first-run config", () => {
  it("provides safe in-memory defaults without projects", () => {
    expect(emptyConfig()).toEqual({
      schemaVersion: 1,
      defaults: {
        worktreeProvider: "noop-worktree",
        terminal: "noop-terminal",
        harness: "noop-harness",
        layout: "agent-shell",
      },
      workspace: DEFAULT_WORKSPACE_CONFIG,
      projects: [],
    });
  });
});
