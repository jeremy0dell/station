import type { Selection } from "@opentui/core";
import { kittySequenceToLegacy } from "../terminal/input/kittyToLegacy.js";
import { stripTerminalReplies } from "../terminal/input/terminalReplies.js";
import {
  copyToClipboard,
  DEFAULT_COPY_SINKS,
  type ClipboardEffects,
} from "./clipboard.js";

type ClipboardSelection = Pick<Selection, "getSelectedText">;
type SelectionSource = {
  getSelection(): ClipboardSelection | null;
};

/**
 * Intercept Ctrl-C only when OpenTUI owns a non-empty selection; otherwise the
 * sequence falls through so Station preserves its normal interrupt/exit path.
 */
export function createOpenTuiSelectionCopyHandler(
  getSource: () => SelectionSource | undefined,
  effects: ClipboardEffects,
): (sequence: string) => boolean {
  return (sequence) => {
    const legacy = kittySequenceToLegacy(stripTerminalReplies(sequence));
    if (legacy !== "\x03") {
      return false;
    }
    const selection = getSource()?.getSelection();
    if (selection === null || selection === undefined) {
      return false;
    }
    return copyToClipboard(selection.getSelectedText(), DEFAULT_COPY_SINKS, effects).copied;
  };
}
