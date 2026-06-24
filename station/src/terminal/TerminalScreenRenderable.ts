import {
  type MouseEvent,
  type OptimizedBuffer,
  Renderable,
  type RenderableOptions,
  type RenderContext,
  RGBA,
} from "@opentui/core";
import { extend } from "@opentui/react";
import type { StationTerminalSize } from "./types.js";
import { buildMouseReportSequence } from "./input/mouseReport.js";
import { MouseTracking } from "./protocol/mouse.js";
import type { VtRow } from "./vt/rows.js";
import type { MouseProtocol, StationVtScreen } from "./vt/screen.js";
import { stationVtTheme } from "./vt/theme.js";
import {
  type CellPoint,
  type CellSelection,
  orderSelection,
  rowColumnsOrdered,
} from "./vt/selection.js";
import { lineRangeAt, wordRangeAt } from "./vt/wordBoundary.js";

const MIN_COLS = 2;
const MIN_ROWS = 1;

type MouseModifiers = { shift: boolean; alt: boolean; ctrl: boolean };
// Consecutive clicks within this window expand to word (2) / line (3).
const MULTI_CLICK_MS = 400;
const SELECTION_BG = "#264f78";

export type TerminalScreenOptions = RenderableOptions<TerminalScreenRenderable> & {
  screen?: StationVtScreen | null;
  /**
   * Fires with the laid-out interior size in cells. This is the source of
   * truth for PTY and screen dimensions: border, padding, and surrounding
   * layout are already absorbed by yoga before this value exists.
   */
  onViewportResize?: (size: StationTerminalSize) => void;
  /** Called with the selected text when a drag/word/line selection completes. */
  onCopySelection?: (text: string) => void;
  /**
   * Called with mouse-report bytes to write to the PTY when the pane's app has
   * mouse reporting on. Lets clicks and hover reach the child (e.g. Claude),
   * which Station otherwise never forwards.
   */
  onForwardInput?: (bytes: string) => void;
  /** Wall-clock source; injectable so multi-click timing is testable. */
  now?: () => number;
};

export class TerminalScreenRenderable extends Renderable {
  #screen: StationVtScreen | null = null;
  #unsubscribe: (() => void) | null = null;
  #onViewportResize: ((size: StationTerminalSize) => void) | undefined;
  #onCopySelection: ((text: string) => void) | undefined;
  #onForwardInput: ((bytes: string) => void) | undefined;
  #now: () => number;
  #rows: VtRow[] = [];
  #rowsVersion = -1;
  // Self-managed selection (we don't use OpenTUI's selectable path so the
  // selection can be pane-aware and word/line-aware). Local cell coords.
  // A non-null #anchor means a drag is in progress (its starting cell).
  #selection: CellSelection | null = null;
  #anchor: CellPoint | null = null;
  // A forward-eligible press whose click-vs-drag verdict is still pending: set on
  // a plain left `down` in a mouse-reporting pane, forwarded as a click on `up`,
  // cleared on `drag` (it became a selection drag instead).
  #pendingClick: { local: CellPoint; modifiers: MouseModifiers } | null = null;
  #copyOnUp = false;
  #lastClickAt = 0;
  #lastClickCell: CellPoint | null = null;
  #clickCount = 0;

  constructor(ctx: RenderContext, options: TerminalScreenOptions) {
    super(ctx, options);
    this.#onViewportResize = options.onViewportResize;
    this.#onCopySelection = options.onCopySelection;
    this.#onForwardInput = options.onForwardInput;
    this.#now = options.now ?? Date.now;
    this.screen = options.screen ?? null;
  }

  get screen(): StationVtScreen | null {
    return this.#screen;
  }

  set screen(value: StationVtScreen | null) {
    if (this.#screen === value) {
      return;
    }
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#screen = value;
    this.#rowsVersion = -1;
    // A new pane's screen invalidates any in-flight selection's coordinates.
    this.#resetSelection();
    if (value !== null) {
      this.#unsubscribe = value.subscribe(() => {
        // Output or a scroll changes what the selection's viewport cells show,
        // so a settled selection's highlight/deferred copy would go stale. Drop
        // it — but leave an in-progress drag (anchor set) to finish and copy on
        // release.
        if (this.#anchor === null) {
          this.#resetSelection();
        }
        this.requestRender();
      });
    }
    this.requestRender();
  }

  set onViewportResize(handler: ((size: StationTerminalSize) => void) | undefined) {
    this.#onViewportResize = handler;
  }

  set onCopySelection(handler: ((text: string) => void) | undefined) {
    this.#onCopySelection = handler;
  }

  set onForwardInput(handler: ((bytes: string) => void) | undefined) {
    this.#onForwardInput = handler;
  }

  protected override onLayoutResize(width: number, height: number): void {
    super.onLayoutResize(width, height);
    // Reflow moves cells; a stale selection would highlight the wrong text.
    this.#resetSelection();
    // The overlay collapses the pane to zero height while keeping it mounted;
    // reporting that would resize the user's shell to nothing. Degenerate
    // sizes are simply not viewports.
    if (width < MIN_COLS || height < MIN_ROWS) {
      return;
    }
    this.#onViewportResize?.({ cols: width, rows: height });
  }

  // --- Selection (mouse drag / double-click word / triple-click line) -------
  // We deliberately don't use OpenTUI's `selectable` path: driving selection
  // ourselves keeps it scoped to this pane's grid and lets us add word/line
  // expansion. OpenTUI still captures the drag and delivers drag/drag-end/up.

  protected override onMouseEvent(event: MouseEvent): void {
    super.onMouseEvent(event);
    const screen = this.#screen;
    if (screen === null) {
      return;
    }
    const local: CellPoint = { x: event.x - this.x, y: event.y - this.y };
    const protocol = screen.mouseProtocol();

    // Buttonless hover: forward only when the app asked for any-event tracking
    // (DECSET 1003). Selection never used motion, so this is purely additive.
    // Shift/Ctrl stay reserved for the outer terminal's own selection.
    if (event.type === "move") {
      if (protocol?.tracking === MouseTracking.Any && !event.modifiers.shift && !event.modifiers.ctrl) {
        this.#forwardPointer(protocol, "motion", local, event.modifiers);
      }
      return;
    }

    switch (event.type) {
      case "down":
        this.#onMouseDown(event, local, protocol);
        break;
      case "drag":
        // Movement turns a deferred click into a drag: cancel the forward and
        // let Station's selection own the gesture (the chosen tradeoff —
        // clicks forward, drags select).
        this.#pendingClick = null;
        if (this.#anchor !== null) {
          this.#setSelection({ anchor: this.#anchor, focus: local });
        }
        break;
      case "drag-end":
        this.#pendingClick = null;
        if (this.#anchor !== null) {
          if (local.x === this.#anchor.x && local.y === this.#anchor.y) {
            this.#clearSelection();
          } else {
            this.#setSelection({ anchor: this.#anchor, focus: local });
            this.#emitCopy();
          }
        }
        this.#anchor = null;
        break;
      case "up":
        this.#onMouseUp(protocol);
        break;
    }
  }

  #onMouseDown(event: MouseEvent, local: CellPoint, protocol: MouseProtocol | null): void {
    // A plain left press in a mouse-reporting pane is a *potential* click: arm a
    // selection anchor so a following drag still selects, but remember to
    // forward it as a click if it releases without moving. Shift/Ctrl fall
    // through to native selection, so they never forward.
    const forwardable =
      protocol !== null && event.button === 0 && !event.modifiers.shift && !event.modifiers.ctrl;
    if (forwardable) {
      // Anchor only (no visible selection yet): the app owns the pointer, so a
      // press-and-hold shows no Station highlight. A following `drag` paints the
      // selection from this anchor; a release with no drag forwards a click.
      this.#pendingClick = { local, modifiers: { ...event.modifiers } };
      this.#anchor = local;
      return;
    }
    this.#onSelectionDown(event, local);
  }

  #onMouseUp(protocol: MouseProtocol | null): void {
    const pending = this.#pendingClick;
    this.#pendingClick = null;
    if (pending !== null) {
      // Press+release with no drag: a click we forward to the app, never a copy.
      // X10 (DECSET 9) is press-only — it has no release event — so skip it there.
      if (protocol !== null) {
        this.#forwardPointer(protocol, "press", pending.local, pending.modifiers);
        if (protocol.tracking !== MouseTracking.X10) {
          this.#forwardPointer(protocol, "release", pending.local, pending.modifiers);
        }
      }
      this.#clearSelection();
      this.#anchor = null;
      return;
    }
    // Word/line selections copy on release; a plain click (no drag-end) clears
    // the selection.
    if (this.#copyOnUp) {
      this.#emitCopy();
      this.#copyOnUp = false;
    } else if (this.#anchor !== null) {
      this.#clearSelection();
    }
    this.#anchor = null;
  }

  #forwardPointer(
    protocol: MouseProtocol,
    action: "press" | "release" | "motion",
    local: CellPoint,
    modifiers: MouseModifiers,
  ): void {
    const forward = this.#onForwardInput;
    const screen = this.#screen;
    if (forward === undefined || screen === null) {
      return;
    }
    // Pane-local cells are 0-based; mouse reports are 1-based, clamped to the
    // PTY grid so a click on the border chrome can't aim outside it.
    const stats = screen.bufferStats();
    const col = clampCell(local.x + 1, stats.cols);
    const row = clampCell(local.y + 1, stats.rows);
    forward(
      buildMouseReportSequence({
        action,
        button: action === "motion" ? "none" : "left",
        col,
        row,
        modifiers,
        encoding: protocol.encoding,
      }),
    );
  }

  #onSelectionDown(event: MouseEvent, local: CellPoint): void {
    this.#copyOnUp = false;
    // The non-forwarding press path: a pane with no mouse reporting, or a
    // Shift/Ctrl-modified press. Only a plain left press starts a Station
    // selection; Shift/Ctrl fall through to the host (outer) terminal's own
    // (flat) selection. When the app *does* have mouse reporting on, a plain
    // left press is handled as a click/drag by #onMouseDown instead, so it
    // never reaches here.
    if (event.button !== 0 || event.modifiers.shift || event.modifiers.ctrl) {
      return;
    }
    const clicks = this.#registerClick(local);
    if (clicks >= 3) {
      this.#selectLine(local.y);
      this.#copyOnUp = this.#selection !== null;
    } else if (clicks === 2) {
      this.#selectWord(local);
      this.#copyOnUp = this.#selection !== null;
    } else {
      this.#anchor = local;
      this.#setSelection({ anchor: local, focus: local });
    }
  }

  #registerClick(local: CellPoint): number {
    const now = this.#now();
    const sameCell = this.#lastClickCell?.x === local.x && this.#lastClickCell?.y === local.y;
    const consecutive = sameCell && now - this.#lastClickAt <= MULTI_CLICK_MS;
    this.#clickCount = consecutive ? this.#clickCount + 1 : 1;
    if (this.#clickCount > 3) {
      this.#clickCount = 1;
    }
    this.#lastClickAt = now;
    this.#lastClickCell = local;
    return this.#clickCount;
  }

  #selectWord(local: CellPoint): void {
    const screen = this.#screen;
    if (screen === null) {
      return;
    }
    const range = wordRangeAt(screen.viewRowText(local.y), local.x);
    if (range.end <= range.start) {
      this.#clearSelection();
      return;
    }
    this.#setSelection({
      anchor: { x: range.start, y: local.y },
      focus: { x: range.end - 1, y: local.y },
    });
  }

  #selectLine(row: number): void {
    const screen = this.#screen;
    if (screen === null) {
      return;
    }
    const range = lineRangeAt(screen.viewRowText(row));
    if (range.end <= range.start) {
      this.#clearSelection();
      return;
    }
    this.#setSelection({ anchor: { x: 0, y: row }, focus: { x: range.end - 1, y: row } });
  }

  #setSelection(selection: CellSelection): void {
    this.#selection = selection;
    this.requestRender();
  }

  #clearSelection(): void {
    if (this.#selection !== null) {
      this.#selection = null;
      this.requestRender();
    }
  }

  #resetSelection(): void {
    this.#anchor = null;
    this.#pendingClick = null;
    this.#copyOnUp = false;
    this.#clearSelection();
  }

  #emitCopy(): void {
    const text = this.getSelectedText();
    if (text.length > 0) {
      this.#onCopySelection?.(text);
    }
  }

  /** Selected text in reading order, each line right-trimmed, newline-joined. */
  getSelectedText(): string {
    const screen = this.#screen;
    const selection = this.#selection;
    if (screen === null || selection === null) {
      return "";
    }
    const ordered = orderSelection(selection);
    const first = Math.max(0, ordered.startY);
    const last = Math.min(this.height - 1, ordered.endY);
    const lines: string[] = [];
    for (let row = first; row <= last; row += 1) {
      const cols = rowColumnsOrdered(ordered, row, this.width);
      if (cols === null) {
        continue;
      }
      lines.push(screen.viewRowText(row, cols.start, cols.end).replace(/\s+$/, ""));
    }
    // Drop trailing blank rows so a drag into the empty area below output
    // doesn't copy (or have the toast count) phantom lines; interior blanks
    // stay. An all-blank selection collapses to "" and is not copied.
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const screen = this.#screen;
    if (screen === null || this.width < MIN_COLS || this.height < MIN_ROWS) {
      return;
    }

    const version = screen.getVersion();
    if (version !== this.#rowsVersion) {
      this.#rows = screen.buildRows();
      this.#rowsVersion = version;
    }

    const defaultFg = rgbaForHex(stationVtTheme.foreground);
    const selectionBg = rgbaForHex(SELECTION_BG);
    // Order the selection once per frame, not once per row.
    const orderedSelection = this.#selection === null ? null : orderSelection(this.#selection);
    const rowLimit = Math.min(this.#rows.length, this.height);
    for (let rowIndex = 0; rowIndex < rowLimit; rowIndex++) {
      const row = this.#rows[rowIndex];
      if (row === undefined) {
        continue;
      }
      const selectedCols =
        orderedSelection === null
          ? null
          : rowColumnsOrdered(orderedSelection, rowIndex, this.width);
      let col = 0;
      for (const span of row.spans) {
        if (col >= this.width) {
          break;
        }
        // Spans can exceed the laid-out width only during a resize race
        // (screen still at the old geometry); draw the part that fits rather
        // than dropping the span or painting into neighboring UI.
        const text =
          col + span.width > this.width ? clipSpanText(span, this.width - col) : span.text;
        if (text.length === 0) {
          break;
        }
        // Highlight the selected sub-range of this span via drawText's selection
        // arg (columns are char indices here; exact for single-width cells).
        const selection = selectionForSpan(selectedCols, col, span.width, selectionBg);
        buffer.drawText(
          text,
          this.x + col,
          this.y + rowIndex,
          span.fg === undefined ? defaultFg : rgbaForHex(span.fg),
          span.bg === undefined ? undefined : rgbaForHex(span.bg),
          span.attributes,
          selection,
        );
        col += span.width;
      }
    }
  }

  protected override destroySelf(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#screen = null;
    super.destroySelf();
  }
}

// Keep a forwarded mouse cell inside the 1-based PTY grid.
function clampCell(value: number, max: number): number {
  return Math.max(1, Math.min(Math.max(1, max), value));
}

// drawText's selection arg highlights columns [start, end) of the drawn text.
// Intersect the row's selected columns with this span's extent and rebase to
// the span's local indices, or null when the span isn't selected.
function selectionForSpan(
  selectedCols: { start: number; end: number } | null,
  spanCol: number,
  spanWidth: number,
  bgColor: RGBA,
): { start: number; end: number; bgColor: RGBA } | null {
  if (selectedCols === null) {
    return null;
  }
  const lo = Math.max(selectedCols.start, spanCol);
  const hi = Math.min(selectedCols.end, spanCol + spanWidth);
  if (hi <= lo) {
    return null;
  }
  return { start: lo - spanCol, end: hi - spanCol, bgColor };
}

// When every char is width 1 (span.width === code-point count) the clip is an
// exact slice; mixed-width tails (rare, only during a resize race) fall back
// to dropping the span for one frame rather than risking a mis-aligned cut.
function clipSpanText(span: VtRow["spans"][number], budget: number): string {
  if (budget <= 0) {
    return "";
  }
  const codePoints = [...span.text];
  if (codePoints.length !== span.width) {
    return "";
  }
  return codePoints.slice(0, budget).join("");
}

// True-color output can mint a distinct hex per cell; cap the memo so a
// gradient-heavy TUI cannot grow it without bound.
const RGBA_CACHE_LIMIT = 4096;
const rgbaCache = new Map<string, RGBA>();

function rgbaForHex(hex: string): RGBA {
  let rgba = rgbaCache.get(hex);
  if (rgba === undefined) {
    if (rgbaCache.size >= RGBA_CACHE_LIMIT) {
      rgbaCache.clear();
    }
    rgba = RGBA.fromHex(hex);
    rgbaCache.set(hex, rgba);
  }
  return rgba;
}

extend({ terminalScreen: TerminalScreenRenderable });

declare module "@opentui/react" {
  interface OpenTUIComponents {
    terminalScreen: typeof TerminalScreenRenderable;
  }
}
