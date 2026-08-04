/**
 * Serialize one pane-local pointer event into PTY mouse-report bytes: SGR when
 * negotiated, legacy X10 otherwise. The caller decides which events to forward.
 */
import {
  encodeMouseButtonByte,
  legacyMouseReport,
  MouseButton,
  MouseEncoding,
  sgrMouseReport,
  type MouseButtonName,
  type MouseEncodingValue,
} from "../protocol/mouse.js";

export type MouseReportEvent = {
  /** press = button down, release = button up, motion = buttonless hover move. */
  action: "press" | "release" | "motion";
  button: MouseButtonName;
  /** 1-based PTY grid cell. */
  col: number;
  row: number;
  modifiers: { shift: boolean; alt: boolean; ctrl: boolean };
  /** SGR (DECSET 1006) vs the legacy byte encoding. */
  encoding: MouseEncodingValue;
};

export function buildMouseReportSequence(event: MouseReportEvent): string {
  // SGR keeps the real button on release (distinguished by a lowercase final);
  // legacy can't, so it collapses every release to the "no button" code.
  const base =
    event.encoding === MouseEncoding.Legacy && event.action === "release"
      ? MouseButton.none
      : MouseButton[event.button];
  const cb = encodeMouseButtonByte({
    base,
    motion: event.action === "motion",
    modifiers: event.modifiers,
  });
  return event.encoding === MouseEncoding.Sgr
    ? sgrMouseReport(cb, event.col, event.row, event.action === "release")
    : legacyMouseReport(cb, event.col, event.row);
}
