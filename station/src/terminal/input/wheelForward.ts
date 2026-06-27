/**
 * Forward wheel ticks to fullscreen apps: SGR wheel events for mouse-reporting
 * apps, arrow keys for cursor-key apps. Scrollback routing stays with the caller.
 */
import { ARROW_KEYS } from "../protocol/cursorKeys.js";
import {
  legacyMouseReport,
  MouseEncoding,
  type MouseEncodingValue,
  MouseWheelButton,
  sgrMouseReport,
} from "../protocol/mouse.js";

export type WheelForwardParams = {
  direction: "up" | "down";
  /** Any DECSET mouse tracking is on — the app wants raw wheel events. */
  mouseReporting: boolean;
  /** Negotiated report encoding (SGR with DECSET 1006, else the legacy bytes). */
  encoding: MouseEncodingValue;
  /** DECCKM — send arrows in application form (ESC O A) vs normal (ESC [ A). */
  applicationCursorKeys: boolean;
  /** PTY grid size, for aiming the synthetic wheel event in-window. */
  cols: number;
  rows: number;
  /** Arrow-key repeats per tick for non-mouse fullscreen apps. */
  lines: number;
};

export function buildWheelForwardSequence(params: WheelForwardParams): string {
  if (params.mouseReporting) {
    // We can't map the host pointer to the pane interior (no click passthrough
    // exists yet), so aim a single wheel "press" at the viewport center in
    // PTY-grid space. Mouse-aware apps act on the wheel regardless of exact cell.
    // Honor the negotiated encoding — an app on legacy tracking (no DECSET 1006)
    // can't parse an SGR report.
    const col = clampCell(Math.floor(params.cols / 2), params.cols);
    const row = clampCell(Math.floor(params.rows / 2), params.rows);
    const button = params.direction === "up" ? MouseWheelButton.Up : MouseWheelButton.Down;
    return params.encoding === MouseEncoding.Sgr
      ? sgrMouseReport(button, col, row, false)
      : legacyMouseReport(button, col, row);
  }
  // Pagers/editors in alt-screen without mouse reporting (less, man, vim)
  // scroll on arrow keys; one arrow per line keeps the wheel step honest.
  const arrow = arrowKey(params.direction, params.applicationCursorKeys);
  return arrow.repeat(Math.max(1, params.lines));
}

function arrowKey(direction: "up" | "down", applicationCursorKeys: boolean): string {
  return applicationCursorKeys ? ARROW_KEYS[direction].application : ARROW_KEYS[direction].normal;
}

function clampCell(value: number, max: number): number {
  return Math.max(1, Math.min(Math.max(1, max), value || 1));
}
