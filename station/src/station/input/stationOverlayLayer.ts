// The STATION dashboard's registration into Station's keymap stack: fills the
// "overlay" priority slot that shipped as a read-only swallow placeholder.
// catchAll (not bindings[]) because dashboard keys are mode-dependent — "N"
// opens a sheet in dashboard mode but is text in search mode; the per-mode
// truth lives in the shared transition machine, and
// reserved chords (Ctrl-O/Ctrl-Q) pierce any catchAll by stack rule. Every
// sequence is consumed (modal); dismiss/exit intents surface as the
// overlay-close outcome so the coordination store owns visibility and focus
// restore. One exception — a Station-session slot key — resolves to a managed
// launch (see catchAll) so the keyboard opens an agent exactly as a click does.
import type { StoreApi } from "zustand/vanilla";
import type { KeymapLayer } from "../../input/keymap/keymaps.js";
import {
  paneLaunchForkSessionOutcome,
  paneLaunchManagedOutcome,
  paneLaunchNewSessionOutcome,
  type RouteOutcome,
} from "../../input/router.js";
import { STATION_OVERLAY_ID } from "../../state/types.js";
import type { TuiStore } from "@station/dashboard-core";
import {
  handleStationSequence,
  resolveKeyFocusedRowAgentTarget,
  resolveKeyForkSessionSubmit,
  resolveKeyNewSessionSubmit,
  resolveKeyRowAgentTarget,
} from "./stationActions.js";

export function createStationOverlayLayer(
  stationViewStore: StoreApi<TuiStore>,
): KeymapLayer<RouteOutcome> {
  return {
    id: "overlay",
    isActive: (state) => state.input.activeOverlay === STATION_OVERLAY_ID,
    bindings: [],
    catchAll: (key) => {
      // A row slot key opens its row exactly as a click does: same
      // RowAgentTarget, same paneLaunchManagedOutcome. Anything else returns
      // `none` and flows to the machine below.
      const target = resolveKeyRowAgentTarget(stationViewStore, key);
      if (target.kind === "launch-managed") {
        return paneLaunchManagedOutcome(target);
      }
      // Enter on the focused row (dashboard cursor) takes the same managed
      // launch; the machine's terminal.focus can't reach Station-hosted panes.
      const focusedTarget = resolveKeyFocusedRowAgentTarget(stationViewStore, key);
      if (focusedTarget.kind === "launch-managed") {
        return paneLaunchManagedOutcome(focusedTarget);
      }
      // Focused Enter and direct C on New Session host the agent in Station;
      // every successful native create must bypass the standalone session.create effect.
      const submit = resolveKeyNewSessionSubmit(stationViewStore, key);
      if (submit.kind === "submit") {
        return paneLaunchNewSessionOutcome(submit);
      }
      // Enter on the Fork details screen seeds a worktree (worktree.fork) and
      // hosts the inherited harness in Station, bypassing the machine's
      // tmux-bound session.fork the same way New Session bypasses session.create.
      const fork = resolveKeyForkSessionSubmit(stationViewStore, key);
      if (fork.kind === "submit") {
        return paneLaunchForkSessionOutcome(fork);
      }
      // Renderer-owned project-header effects return through the key outcome so
      // native keyboard activation enters the same pane/launch executor as mouse.
      const outcome = handleStationSequence(stationViewStore, key);
      if (outcome.kind === "close-overlay") {
        return { kind: "overlay-close", overlayId: STATION_OVERLAY_ID };
      }
      if (outcome.kind === "open-pane") {
        const paneOpen: Extract<RouteOutcome, { kind: "pane-open" }> = {
          kind: "pane-open",
          paneId: outcome.target.paneId,
          cwd: outcome.target.cwd,
          role: outcome.target.role,
        };
        if (outcome.target.command !== undefined) {
          paneOpen.command = outcome.target.command;
        }
        if (outcome.target.args !== undefined) {
          paneOpen.args = outcome.target.args;
        }
        if (outcome.target.worktreeId !== undefined) {
          paneOpen.worktreeId = outcome.target.worktreeId;
        }
        return paneOpen;
      }
      if (outcome.kind === "launch-new-session") {
        return paneLaunchNewSessionOutcome(outcome.target);
      }
      return { kind: "swallowed" };
    },
  };
}
