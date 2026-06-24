import { basename } from "node:path";
import "./TerminalScreenRenderable.js";
import type { PaneId } from "../state/types.js";
import { usePaneTerminal } from "./registry/paneTerminalContext.js";

/** Primary-agent blue; split shells use non-blue accents from PaneGrid. */
export const PANE_BORDER_INACTIVE = "#1d4ed8";
export const PANE_BORDER_ACTIVE = "#60a5fa";

export type TerminalPaneProps = {
  paneId: PaneId;
  /** Called with selected text when a drag/word/line selection completes. */
  onCopySelection?: (text: string) => void;
  /**
   * Called with mouse-report bytes to write to the PTY when the pane's app has
   * mouse reporting on. PaneGrid supplies this (it gates on modal state), so a
   * bare TerminalPane (tests) simply doesn't forward.
   */
  onForwardInput?: (bytes: string) => void;
  /** Visual only: the pane border color. PaneGrid passes the active accent. */
  borderColor?: string;
  title?: string;
};

/**
 * View over one registry entry. The registry owns PTY lifecycle; unmounting this
 * component must never dispose a live background pane.
 */
export function TerminalPane({
  paneId,
  onCopySelection,
  onForwardInput,
  borderColor = PANE_BORDER_INACTIVE,
  title,
}: TerminalPaneProps) {
  const term = usePaneTerminal(paneId);

  return (
    <box
      width="100%"
      flexGrow={1}
      border
      borderColor={borderColor}
      title={paneTitle(title, term.status, term.oscTitle, term.cwd)}
      padding={1}
    >
      <terminalScreen
        width="100%"
        flexGrow={1}
        screen={term.screen}
        onViewportResize={term.reportSize}
        onCopySelection={onCopySelection}
        onForwardInput={onForwardInput}
      />
    </box>
  );
}

function paneTitle(
  title: string | undefined,
  status: string,
  oscTitle?: string,
  cwd?: string,
): string {
  // Semantic title (agent/worktree/project) wins; aux panes have none, so fall
  // back the way terminal emulators do — the app-set OSC title, then the spawn
  // directory — instead of the bare "terminal pid N".
  const base = title ?? oscTitle ?? auxCwdLabel(cwd);
  if (base === undefined) {
    return `terminal ${status}`;
  }
  return status.startsWith("pid ") ? base : `${base} - ${status}`;
}

function auxCwdLabel(cwd: string | undefined): string | undefined {
  if (cwd === undefined) {
    return undefined;
  }
  const name = basename(cwd);
  return name.length > 0 ? name : undefined;
}
