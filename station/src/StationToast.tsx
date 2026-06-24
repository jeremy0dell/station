import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import { selectToast } from "./state/selectors.js";
import type { StationStore } from "./state/store.js";
import { STATION_COLORS } from "./station/view/theme.js";

// App-level toast pinned to the bottom-right of the whole Station window — above
// the shell pane AND the STATION overlay (high zIndex, absolute so nothing reflows
// for it). Deliberately distinct from the STATION overlay toast (stationViewStore
// pushToast / ToastOverlayView), which is scoped to the overlay and hidden while
// the shell is showing — copy confirmations must be visible over the shell too.
// Colors come from the shared palette so the two toasts stay visually in sync.
const TOAST_DISMISS_MS = 2500;

export function StationToast({ store }: { store: StationStore }) {
  const getToast = () => selectToast(store.getState());
  const toast = useSyncExternalStore(store.subscribe, getToast, getToast);
  // Re-armed per token, so a newer toast's timer can't clear an older one (and
  // vice versa); the store's dismissToast no-ops unless the token still matches.
  const token = toast?.token ?? null;
  useEffect(() => {
    if (token === null) {
      return;
    }
    const timer = setTimeout(() => store.actions.dismissToast(token), TOAST_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [store, token]);

  if (toast === null) {
    return null;
  }
  return (
    <box
      position="absolute"
      right={2}
      bottom={1}
      zIndex={100}
      backgroundColor={toast.kind === "error" ? STATION_COLORS.red : STATION_COLORS.blue}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={STATION_COLORS.background}>{toast.message}</text>
    </box>
  );
}
