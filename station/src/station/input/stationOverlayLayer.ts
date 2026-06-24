// The STATION dashboard's registration into Station's keymap stack: fills the
// "overlay" priority slot that shipped as a read-only swallow placeholder.
// catchAll (not bindings[]) because dashboard keys are mode-dependent — "N"
// opens a sheet in dashboard mode but is text in search mode; the per-mode
// truth lives in the keymap tables + shared machine (stationKeymap.ts), and
// reserved chords (Ctrl-O/Ctrl-Q) pierce any catchAll by stack rule. Every
// sequence is consumed (modal); dismiss/exit intents surface as the
// overlay-close outcome so the coordination store owns visibility and focus
// restore. One exception — a worktree-row slot key — resolves to a managed
// launch (see catchAll) so the keyboard opens an agent exactly as a click does.
import type { StoreApi } from "zustand/vanilla";
import type { KeymapLayer } from "../../input/keymaps.js";
import {
  paneLaunchManagedOutcome,
  paneLaunchNewSessionOutcome,
  type RouteOutcome,
} from "../../input/router.js";
import { STATION_OVERLAY_ID } from "../../state/types.js";
import type { TuiStore } from "@station/dashboard-core";
import {
  handleStationSequence,
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
      // Enter on the New Session review screen hosts the agent in Station
      // (create worktree + managed launch) rather than the machine's tmux
      // session.create — which Station can't render as a pane.
      const submit = resolveKeyNewSessionSubmit(stationViewStore, key);
      if (submit.kind === "submit") {
        return paneLaunchNewSessionOutcome(submit);
      }
      const outcome = handleStationSequence(stationViewStore, key);
      if (outcome.kind === "close-overlay") {
        return { kind: "overlay-close", overlayId: STATION_OVERLAY_ID };
      }
      return { kind: "swallowed" };
    },
  };
}
