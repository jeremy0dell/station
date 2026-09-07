import type { TerminalPopupControl } from "@station/contracts";
import { dismissTmuxPopup, resolveTmuxPopupFocusTarget } from "./index.js";
import type { TmuxPopupFocusOriginOptions } from "./types.js";

/**
 * ADAPTER
 *
 * Resolves popup controls through tmux's current claim and preserves exact dismissal ownership.
 */
export function createTmuxPopupControl(
  options: TmuxPopupFocusOriginOptions = {},
): TerminalPopupControl {
  const env = { ...(options.env ?? process.env) };
  if ((options.config?.popupScope ?? "server") === "server") {
    // A shared renderer follows the current claim rather than its startup client.
    delete env.STATION_FOCUS_CLIENT_ID;
  }
  const popupOptions = { ...options, env };
  return {
    dismissPopup: () => dismissTmuxPopup(popupOptions),
    openShell: async (cwd) => {
      const target = await resolveTmuxPopupFocusTarget(popupOptions);
      if (target === undefined) return { opened: false };
      const shell = await target.openShell(cwd);
      if (!shell.opened) return shell;
      const dismissed = await target.dismissExact();
      return { opened: dismissed.dismissed };
    },
    resolveFocusTarget: () => resolveTmuxPopupFocusTarget(popupOptions),
  };
}
