import type { TerminalFocusOrigin } from "./commands/terminal.js";

export type TerminalPopupResult = { opened: true } | { opened: false; closed: true };

/**
 * DRIVEN PORT
 *
 * Opens or toggles the dashboard through a terminal integration. Composition binds the
 * renderer launch inputs; the integration owns persistence, freshness, and replacement.
 */
export interface TerminalPopupLauncher {
  open(): Promise<TerminalPopupResult>;
}

export type TerminalPopupFocusTarget = {
  origin: TerminalFocusOrigin;
  dismissExact: () => Promise<{ dismissed: boolean }>;
};

/**
 * DRIVEN PORT
 *
 * Controls a popup without exposing terminal commands or persistent resource identities.
 * Exact dismissal applies only to the freshly resolved target; uncertain ownership refuses effects.
 */
export interface TerminalPopupControl {
  dismissPopup(): Promise<{ dismissed: boolean }>;
  /** Opens the shell and completes any exact popup dismissal owned by the integration. */
  openShell?(cwd: string): Promise<{ opened: boolean }>;
  resolveFocusTarget(): Promise<TerminalPopupFocusTarget | undefined>;
}
