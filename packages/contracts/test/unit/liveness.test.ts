import { describe, expect, it } from "vitest";
import type { AgentState, TerminalState, WorktreeRow } from "../../src/index.js";
import { isRunningAgentState, worktreeHasLiveAgent } from "../../src/index.js";

function row(agentState?: AgentState, terminalState?: TerminalState): WorktreeRow {
  return {
    agent: agentState === undefined ? undefined : { state: agentState },
    terminal: terminalState === undefined ? undefined : { state: terminalState },
  } as unknown as WorktreeRow;
}

const ACTIVE: AgentState[] = ["starting", "idle", "working", "needs_attention", "stuck"];

describe("worktreeHasLiveAgent (launch-liveness)", () => {
  it("treats active agent states as live regardless of terminal", () => {
    for (const state of ACTIVE) {
      expect(worktreeHasLiveAgent(row(state))).toBe(true);
    }
  });

  it("never treats none / exited / no-agent / no-row as live", () => {
    expect(worktreeHasLiveAgent(row("none"))).toBe(false);
    expect(worktreeHasLiveAgent(row("exited"))).toBe(false);
    expect(worktreeHasLiveAgent(row(undefined))).toBe(false);
    expect(worktreeHasLiveAgent(undefined)).toBe(false);
  });

  it("treats unknown as live only when a non-stale terminal backs it", () => {
    // The "?" row noop bug: unknown with a dead/absent terminal must be launchable.
    expect(worktreeHasLiveAgent(row("unknown"))).toBe(false);
    expect(worktreeHasLiveAgent(row("unknown", "none"))).toBe(false);
    expect(worktreeHasLiveAgent(row("unknown", "stale"))).toBe(false);
    expect(worktreeHasLiveAgent(row("unknown", "open"))).toBe(true);
    expect(worktreeHasLiveAgent(row("unknown", "detached"))).toBe(true);
    expect(worktreeHasLiveAgent(row("unknown", "unknown"))).toBe(true);
  });
});

describe("isRunningAgentState (cleanup/force)", () => {
  it("counts active states and unknown as running; not none / exited / undefined", () => {
    for (const state of [...ACTIVE, "unknown" as AgentState]) {
      expect(isRunningAgentState(state)).toBe(true);
    }
    expect(isRunningAgentState("none")).toBe(false);
    expect(isRunningAgentState("exited")).toBe(false);
    expect(isRunningAgentState(undefined)).toBe(false);
  });
});
