import type { ContextMenuState } from "../contextMenu/types.js";
import type { ProviderId } from "@station/contracts";

export type PaneId = string;
export type OverlayId = string;

export const MAIN_PANE_ID: PaneId = "pane-main";
export const STATION_OVERLAY_ID: OverlayId = "station";

/** Deterministic ids make repeated "open shell here" actions reveal, not spawn. */
export function worktreePaneId(worktreeId: string): PaneId {
  return `pane-wt-${worktreeId}`;
}

const AGENT_WORKTREE_PANE_PREFIX = "pane-agent-wt-";

/**
 * The pane id for a worktree session's primary agent. A distinct prefix from
 * worktreePaneId so a worktree's agent pane never collides with its `[+sh]`
 * shell pane: a session can host both its agent and an explicit shell at once.
 */
export function agentWorktreePaneId(worktreeId: string): PaneId {
  return `${AGENT_WORKTREE_PANE_PREFIX}${worktreeId}`;
}

/**
 * Inverse of {@link agentWorktreePaneId}: the worktree id a primary-agent pane
 * encodes, or `undefined` when the pane is not a primary-agent pane. Lets a
 * consumer recover the worktree from the pane id without a parallel map (the id
 * is the single source of truth for the agent↔worktree link).
 */
export function worktreeIdFromAgentPaneId(paneId: PaneId): string | undefined {
  return paneId.startsWith(AGENT_WORKTREE_PANE_PREFIX)
    ? paneId.slice(AGENT_WORKTREE_PANE_PREFIX.length)
    : undefined;
}

export function projectPaneId(projectId: string): PaneId {
  return `pane-proj-${projectId}`;
}

const AUX_TARGET_PREFIX = "aux:";

/** Aux host target ids derive from pane ids so warm restore can recompute them. */
export function auxTerminalTargetId(paneId: PaneId): string {
  return `${AUX_TARGET_PREFIX}${paneId}`;
}

/**
 * Inverse of {@link auxTerminalTargetId}: the pane id an aux target encodes, or
 * `undefined` when the id is not an aux target or carries no pane id (a bare
 * `"aux:"` from a hand-edited host — adopt it under a generated id instead).
 */
export function paneIdFromAuxTarget(terminalTargetId: string): PaneId | undefined {
  if (!terminalTargetId.startsWith(AUX_TARGET_PREFIX)) {
    return undefined;
  }
  const paneId = terminalTargetId.slice(AUX_TARGET_PREFIX.length);
  return paneId.length > 0 ? paneId : undefined;
}

export type PaneSplitDirection = "right" | "below";

/**
 * What a pane is for. `"shell"` is the `[+sh]` plain shell (and the boot pane);
 * `"primary-agent"` is a worktree session's agent process. Role rides on the
 * pane record (not a parallel map) and is orthogonal to focus/active — it only
 * records intent so the agent can be re-found.
 */
export type PaneRole = "primary-agent" | "shell";

/**
 * Observer-minted identity for a managed primary agent; exit reports use the
 * terminal target id to close the observer session.
 */
export type AgentIdentity = {
  sessionId: string;
  terminalTargetId: string;
  harnessProvider?: ProviderId;
};

export type PaneRecord = {
  id: PaneId;
  split: null | {
    anchorPaneId: PaneId;
    direction: PaneSplitDirection;
  };
  role: PaneRole;
  /** Present only on a `"primary-agent"` pane: the observer-minted STATION identity. */
  agentIdentity?: AgentIdentity;
};

export type HeaderRegion = "tabs" | "island" | "title";

/**
 * Single app focus vocabulary; panes do not use OpenTUI focusables, so explicit
 * store actions are the only focus mutations.
 */
export type FocusTarget =
  | { kind: "header"; region: HeaderRegion }
  | { kind: "welcome" }
  | { kind: "pane"; paneId: PaneId }
  | { kind: "overlay"; overlayId: OverlayId }
  | { kind: "contextMenu" };

export type WorkspaceSlice = {
  panes: readonly PaneRecord[];
  activePaneId: PaneId | null;
};

export type InputSlice = {
  focus: FocusTarget;
  /**
   * The welcome screen is showing as a boot intro layered over the restored
   * workspace (ephemeral, never persisted). Dismissed into the sessions
   * underneath; distinct from the empty-workspace welcome, which shows whenever
   * there are no panes regardless of this flag.
   */
  introVisible: boolean;
  activeOverlay: OverlayId | null;
  /** Focus to restore when the overlay closes; only pane focus is recorded. */
  overlayReturnFocus: FocusTarget | null;
  contextMenu: ContextMenuState | null;
};

/**
 * A transient, app-level notification anchored bottom-right of the whole
 * Station window (above the shell and the STATION overlay alike). `token` is
 * bumped per toast so the view can schedule a fresh auto-dismiss and a newer
 * toast cannot be cleared by an older one's timer.
 */
export type StationToast = {
  token: number;
  message: string;
  kind: "info" | "error";
};

export type FeedbackSlice = {
  toast: StationToast | null;
};

export type StationState = {
  workspace: WorkspaceSlice;
  input: InputSlice;
  feedback: FeedbackSlice;
};
