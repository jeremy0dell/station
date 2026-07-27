import type { Selection } from "@opentui/core";
import {
  copyToClipboard,
  DEFAULT_COPY_SINKS,
  type ClipboardEffects,
} from "./clipboard.js";

type ClipboardSelection = Pick<Selection, "getSelectedText">;
type SelectionEmitter = {
  on(event: "selection", listener: (selection: ClipboardSelection) => void): unknown;
};

/** Copy a completed OpenTUI drag through the same sinks as a terminal-pane yank. */
export function wireOpenTuiSelectionCopy(
  emitter: SelectionEmitter,
  effects: ClipboardEffects,
): void {
  emitter.on("selection", (selection) => {
    copyToClipboard(selection.getSelectedText(), DEFAULT_COPY_SINKS, effects);
  });
}
