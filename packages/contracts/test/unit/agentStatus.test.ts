import { describe, expect, it } from "vitest";
import type { AgentState, AgentStatusDefinition, WorktreeRow } from "../../src/index.js";
import { AGENT_STATUS, worktreeDisplayForAgentState } from "../../src/index.js";

const EXPECTED_DEFINITIONS = {
  needs_attention: { label: "needs attention", priority: 10, alert: true, warning: false },
  stuck: { label: "stuck", priority: 20, alert: true, warning: true },
  working: { label: "working", priority: 30, alert: false, warning: false },
  starting: { label: "starting", priority: 35, alert: false, warning: false },
  idle: { label: "idle", priority: 40, alert: false, warning: false },
  unknown: { label: "unknown", priority: 50, alert: false, warning: false },
  exited: { label: "exited", priority: 60, alert: false, warning: false },
  none: { label: "no agent", priority: 70, alert: false, warning: false },
} as const satisfies Record<AgentState, AgentStatusDefinition>;

describe("agent status policy", () => {
  it("projects every canonical worktree display without false optional warnings", () => {
    for (const state of Object.keys(EXPECTED_DEFINITIONS) as AgentState[]) {
      const definition = EXPECTED_DEFINITIONS[state];
      const expected: WorktreeRow["display"] = {
        statusLabel: definition.label,
        sortPriority: definition.priority,
        alert: definition.alert,
      };
      if (definition.warning) expected.warning = true;
      expect(AGENT_STATUS[state]).toEqual(definition);
      const display = worktreeDisplayForAgentState(state);
      expect(display).toEqual(expected);
      expect("warning" in display).toBe(state === "stuck");
    }
  });

  it("normalizes an absent agent state to none", () => {
    expect(worktreeDisplayForAgentState(undefined)).toEqual({
      statusLabel: "no agent",
      sortPriority: 70,
      alert: false,
    });
  });
});
