import { basename } from "node:path";
import type { ColorInput } from "@opentui/core";
import "./TerminalScreenRenderable.js";
import type { PaneId } from "../state/types.js";
import {
  stationColorSnapshotValue,
  toOpenTuiColor,
  useStationTheme,
} from "../theme/index.js";
import { usePaneTerminal } from "./registry/paneTerminalContext.js";

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
  borderColor?: ColorInput;
  title?: string;
  /** Interior padding in cells between the border and the terminal screen. */
  paddingX?: number;
  paddingY?: number;
};

/**
 * View over one registry entry. The registry owns PTY lifecycle; unmounting this
 * component must never dispose a live background pane.
 */
export function TerminalPane({
  paneId,
  onCopySelection,
  onForwardInput,
  borderColor,
  title,
  paddingX = 0,
  paddingY = 0,
}: TerminalPaneProps) {
  const theme = useStationTheme();
  const term = usePaneTerminal(paneId);
  const resolvedBorderColor = borderColor ?? toOpenTuiColor(theme.pane.primary.inactive);

  return (
    <box
      width="100%"
      flexGrow={1}
      border
      borderColor={resolvedBorderColor}
      title={paneTitle(title, term.status, term.oscTitle, term.cwd)}
      paddingX={paddingX}
      paddingY={paddingY}
    >
      <terminalScreen
        width="100%"
        flexGrow={1}
        screen={term.screen}
        defaultForeground={theme.terminal.defaultForeground.value}
        selectionBackground={stationColorSnapshotValue(theme.pane.selection)}
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
