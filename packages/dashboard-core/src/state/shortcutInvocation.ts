import { isDashboardShortcutCode } from "../selectors/dashboardShortcuts.js";
import { type DashboardCommandShortcut, dashboardCommandShortcut } from "./keymap.js";

export type DashboardShortcutInvocation =
  | { kind: "session"; code: string }
  | { kind: "command"; command: DashboardCommandShortcut }
  | { kind: "invalid" };

/** Parses the backtick collector's case-sensitive command and session shortcut grammar. */
export function dashboardShortcutInvocation(input: string): DashboardShortcutInvocation {
  if (isDashboardShortcutCode(input)) {
    return { kind: "session", code: input };
  }

  const command = dashboardCommandShortcut(input);
  return command === undefined ? { kind: "invalid" } : { kind: "command", command };
}
