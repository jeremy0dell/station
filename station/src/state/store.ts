import {
  type AgentIdentity,
  type FocusTarget,
  type OverlayId,
  type PaneId,
  type PaneRecord,
  type PaneRole,
  type PaneSplitDirection,
  type StationState,
} from "./types.js";
import type { ContextMenuAnchor, ContextMenuTarget } from "../contextMenu/types.js";
import { resolveInitialState, type StationStoreOptions } from "./initialState.js";
import { paneTreeIds } from "./paneTree.js";
import { closeContextMenuState, openContextMenuState } from "./reducers/contextMenu.js";
import { closeOverlayState, openOverlayState } from "./reducers/overlay.js";
import { fallbackFocus, hasPane, withActivePane } from "./reducers/paneFocus.js";
import { inputAfterPaneRemoval } from "./reducers/paneRemoval.js";

export type { StationStoreOptions };

export type CreatePaneOptions = {
  split?: {
    anchorPaneId: PaneId;
    direction: PaneSplitDirection;
  };
  /** Defaults to `"shell"`; the agent open-pane path passes `"primary-agent"`. */
  role?: PaneRole;
};

export type StationStoreActions = {
  createPane(paneId: PaneId, options?: CreatePaneOptions): void;
  /**
   * Stamp an existing pane with observer-minted primary-agent identity so exits
   * report back. Does not affect focus/overlay; identical or absent panes no-op.
   */
  setPrimaryAgent(paneId: PaneId, identity: AgentIdentity): void;
  closePane(paneId: PaneId): void;
  /**
   * Remove every pane in the forest tree rooted at `agentPaneId`, then switch
   * the active pane to a surviving tree (preferring one with an agent) or null
   * (welcome screen). This is the UI reaction to an observer *session removal*,
   * driven by the sessionReaper — not a generic pane close. No-op when absent.
   */
  closePaneTree(agentPaneId: PaneId): void;
  /**
   * Reveal an existing pane without spawning a duplicate; open overlays keep
   * focus and get this pane as their return target.
   */
  revealPane(paneId: PaneId): void;
  focusPane(paneId: PaneId): void;
  /**
   * Cycle the active pane to the next record in creation order, wrapping at the
   * end. Overlay-aware through the same `withActivePane` helper create/reveal
   * use (under an open overlay it queues the next pane as the return focus
   * instead of stealing focus). A single pane is a same-reference no-op.
   */
  focusNextPane(): void;
  /**
   * Dismiss the boot intro into the workspace underneath: clear `introVisible`
   * and move focus from the welcome layer to the active pane (or the standard
   * fallback when none). A no-op when the intro is not showing.
   */
  dismissWelcomeIntro(): void;
  openOverlay(overlayId: OverlayId): void;
  closeOverlay(): void;
  toggleOverlay(overlayId: OverlayId): void;
  openContextMenu(target: ContextMenuTarget, anchor: ContextMenuAnchor): void;
  closeContextMenu(): void;
  setContextMenuActiveIndex(activeIndex: number): void;
  /** Show a bottom-right app toast (e.g. a copy confirmation). */
  showToast(message: string, kind?: "info" | "error"): void;
  /** Clear the toast if it still carries `token` (ignores a superseded timer). */
  dismissToast(token: number): void;
};

export type StationStore = {
  getState(): StationState;
  subscribe(listener: () => void): () => void;
  actions: StationStoreActions;
};

/**
 * Vanilla coordination store only; live PTYs, buffers, and renderer refs stay in
 * registries. No singleton: main owns the instance, and HMR may reuse it, so
 * subscribers must detach on dispose/unmount.
 */
export function createStationStore(options?: StationStoreOptions): StationStore {
  let state = resolveInitialState(options);
  const listeners = new Set<() => void>();
  // Monotonic so every toast (even an identical message) supersedes the last
  // and owns its own auto-dismiss timer.
  let toastToken = 0;

  // Reducers return the same reference for no-op actions; setState only
  // notifies on reference change, so no-op actions never re-render.
  function setState(next: StationState): void {
    if (next === state) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions: {
      // Created once (no-op if the id already has a record); the runtime PtyRegistry
      // owns the live process. The record carries role (default "shell") and split.
      createPane: (paneId, options) => {
        if (hasPane(state.workspace.panes, paneId)) {
          return;
        }
        const explicitSplit = options?.split;
        if (explicitSplit !== undefined && !hasPane(state.workspace.panes, explicitSplit.anchorPaneId)) {
          return;
        }
        // Explicit split tiles the new pane inside the current session; no split roots
        // its OWN full-screen session. buildPaneForest keeps each split:null pane as
        // its own root so the renderer shows just the active session.
        const record: PaneRecord = {
          id: paneId,
          split: explicitSplit ?? null,
          role: options?.role ?? "shell",
        };
        const appended: StationState = {
          ...state,
          workspace: { ...state.workspace, panes: [...state.workspace.panes, record] },
        };
        setState(withActivePane(appended, paneId));
      },
      // Role bookkeeping only: flips an existing pane's record to "primary-agent"
      // and stamps its observer-minted identity onto the record so its exit can
      // be reported. Deliberately leaves focus/overlay to the open-pane chain
      // (createPane/revealPane already placed the pane), so withActivePane's
      // invariants are untouched.
      setPrimaryAgent: (paneId, identity) => {
        const record = state.workspace.panes.find((pane) => pane.id === paneId);
        if (record === undefined) {
          return;
        }
        const nextIdentity: AgentIdentity =
          identity.harnessProvider === undefined &&
          record.agentIdentity?.sessionId === identity.sessionId &&
          record.agentIdentity.terminalTargetId === identity.terminalTargetId &&
          record.agentIdentity.harnessProvider !== undefined
            ? { ...identity, harnessProvider: record.agentIdentity.harnessProvider }
            : identity;
        if (
          record.role === "primary-agent" &&
          record.agentIdentity?.sessionId === nextIdentity.sessionId &&
          record.agentIdentity.terminalTargetId === nextIdentity.terminalTargetId &&
          record.agentIdentity.harnessProvider === nextIdentity.harnessProvider
        ) {
          return;
        }
        setState({
          ...state,
          workspace: {
            ...state.workspace,
            panes: state.workspace.panes.map((pane) =>
              pane.id === paneId
                ? { ...pane, role: "primary-agent", agentIdentity: nextIdentity }
                : pane,
            ),
          },
        });
      },
      // Overlay-aware via the same withActivePane helper createPane uses: revealing
      // under an overlay queues the pane as return focus instead of yanking it forward.
      revealPane: (paneId) => {
        if (!hasPane(state.workspace.panes, paneId)) {
          return;
        }
        setState(withActivePane(state, paneId));
      },
      // Focus/active retarget in-store; the registry disposes the live process
      // separately. The agent's identity rides on its record, so it is gone with the
      // filter below — no separate map to prune.
      closePane: (paneId) => {
        const closedPane = state.workspace.panes.find((pane) => pane.id === paneId);
        if (closedPane === undefined) {
          return;
        }
        const panes = state.workspace.panes
          .filter((pane) => pane.id !== paneId)
          .map((pane) =>
            pane.split?.anchorPaneId === paneId ? { ...pane, split: closedPane.split } : pane,
          );
        // Retarget the active pane to a survivor in the closed pane's OWN
        // session (its split anchor first, else any session sibling) so closing
        // a pane never jumps the view to another worktree's session. Only when
        // the whole session is gone fall back to an adjacent pane (the one that
        // shifts into the closed slot, else the previous one).
        const closedIndex = state.workspace.panes.findIndex((pane) => pane.id === paneId);
        const treePaneIds = paneTreeIds(state.workspace.panes, paneId);
        const anchorId = closedPane.split?.anchorPaneId;
        const neighbor =
          (anchorId !== undefined ? panes.find((pane) => pane.id === anchorId) : undefined) ??
          panes.find((pane) => treePaneIds.has(pane.id)) ??
          panes[closedIndex] ??
          panes[closedIndex - 1] ??
          null;
        const activePaneId =
          state.workspace.activePaneId === paneId
            ? (neighbor?.id ?? null)
            : state.workspace.activePaneId;
        const workspace = { panes, activePaneId };
        const input = inputAfterPaneRemoval(state, workspace, (id) => id === paneId);
        setState({ ...state, workspace, input });
      },
      closePaneTree: (agentPaneId) => {
        const treePaneIds = paneTreeIds(state.workspace.panes, agentPaneId);
        if (treePaneIds.size === 0) {
          return;
        }
        // Whole trees go at once, so no survivor anchors a closed pane: unlike
        // closePane, no split-anchor repair.
        const panes = state.workspace.panes.filter((pane) => !treePaneIds.has(pane.id));
        const survivor =
          panes.find((pane) => pane.role === "primary-agent") ?? panes[0] ?? null;
        const activePaneId =
          state.workspace.activePaneId !== null && treePaneIds.has(state.workspace.activePaneId)
            ? (survivor?.id ?? null)
            : state.workspace.activePaneId;
        const workspace = { panes, activePaneId };
        const input = inputAfterPaneRemoval(state, workspace, (id) => treePaneIds.has(id));
        setState({ ...state, workspace, input });
      },
      focusPane: (paneId) => {
        if (!hasPane(state.workspace.panes, paneId)) {
          return;
        }
        const focus = state.input.focus;
        if (focus.kind === "pane" && focus.paneId === paneId && state.workspace.activePaneId === paneId) {
          return;
        }
        setState({
          ...state,
          workspace: { ...state.workspace, activePaneId: paneId },
          input: { ...state.input, contextMenu: null, focus: { kind: "pane", paneId } },
        });
      },
      focusNextPane: () => {
        const { panes, activePaneId } = state.workspace;
        if (activePaneId === null) {
          return;
        }
        // Scope to the active pane's forest tree: the renderer shows one
        // session full-screen, so a global cycle would switch sessions.
        const treePaneIds = paneTreeIds(panes, activePaneId);
        const treePanes = panes.filter((pane) => treePaneIds.has(pane.id));
        if (treePanes.length <= 1) {
          return;
        }
        const currentIndex = treePanes.findIndex((pane) => pane.id === activePaneId);
        const next = treePanes[(currentIndex + 1) % treePanes.length];
        if (next === undefined) {
          return;
        }
        setState(withActivePane(state, next.id));
      },
      dismissWelcomeIntro: () => {
        if (!state.input.introVisible) {
          return;
        }
        const focus: FocusTarget =
          state.workspace.activePaneId !== null
            ? { kind: "pane", paneId: state.workspace.activePaneId }
            : fallbackFocus(state);
        setState({ ...state, input: { ...state.input, introVisible: false, focus } });
      },
      openOverlay: (overlayId) => {
        setState(openOverlayState(state, overlayId));
      },
      closeOverlay: () => {
        setState(closeOverlayState(state));
      },
      // Self-contained so route-then-execute never reads stale overlay state.
      toggleOverlay: (overlayId) => {
        setState(
          state.input.activeOverlay === overlayId
            ? closeOverlayState(state)
            : openOverlayState(state, overlayId),
        );
      },
      openContextMenu: (target, anchor) => {
        setState(openContextMenuState(state, target, anchor));
      },
      closeContextMenu: () => {
        setState(closeContextMenuState(state));
      },
      setContextMenuActiveIndex: (activeIndex) => {
        const contextMenu = state.input.contextMenu;
        if (contextMenu === null || contextMenu.activeIndex === activeIndex) {
          return;
        }
        setState({
          ...state,
          input: {
            ...state.input,
            contextMenu: { ...contextMenu, activeIndex },
          },
        });
      },
      showToast: (message, kind = "info") => {
        toastToken += 1;
        setState({ ...state, feedback: { toast: { token: toastToken, message, kind } } });
      },
      dismissToast: (token) => {
        const current = state.feedback.toast;
        if (current === null || current.token !== token) {
          return;
        }
        setState({ ...state, feedback: { toast: null } });
      },
    },
  };
}
