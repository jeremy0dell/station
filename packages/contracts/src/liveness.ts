import type { AgentState } from "./observations.js";
import type { WorktreeRow } from "./snapshot.js";

const RUNNING_AGENT_STATES: ReadonlySet<AgentState> = new Set([
  "starting",
  "idle",
  "working",
  "needs_attention",
  "stuck",
  "unknown",
]);

/**
 * "Running" for the destructive guards (remove/close require --force): `unknown`
 * counts as running on purpose, so an uncertain run isn't torn down silently.
 * Distinct from worktreeHasLiveAgent — do NOT use this to gate launch vs focus.
 */
export function isRunningAgentState(state: AgentState | undefined): boolean {
  return state !== undefined && RUNNING_AGENT_STATES.has(state);
}

/**
 * A worktree's terminal target is gone or unusable: no target at all, or one the
 * provider reports as `none`/`stale`. The signal that an agent we once observed
 * is no longer reachable (its PTY died, Station closed, the tmux pane vanished).
 */
function terminalIsStaleOrMissing(row: WorktreeRow): boolean {
  return (
    row.terminal === undefined || row.terminal.state === "none" || row.terminal.state === "stale"
  );
}

/**
 * Launch-liveness, not destructive running-state. `unknown` is live only while
 * its terminal is reachable, so stale `?` rows can relaunch; open/create/resume
 * all use this helper and decide the same way.
 */
export function worktreeHasLiveAgent(row: WorktreeRow | undefined): boolean {
  if (row?.agent === undefined) {
    return false;
  }
  const state = row.agent.state;
  if (state === "none" || state === "exited") {
    return false;
  }
  if (state === "unknown") {
    return !terminalIsStaleOrMissing(row);
  }
  return true;
}
