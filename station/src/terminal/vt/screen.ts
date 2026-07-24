import { Unicode11Addon } from "@xterm/addon-unicode11";
import { type IMarker, Terminal } from "@xterm/headless";
import type { ScrollOnOutputMode } from "../../config/stationConfig.js";
import { ChunkRing } from "../chunkRing.js";
import {
  reportTerminalCorruption,
  type TerminalCorruptionKind,
  writePaneEvidenceDump,
} from "../diagnostics.js";
import { CsiFinal, EraseInDisplayMode } from "../protocol/controlBytes.js";
import { DecMode } from "../protocol/decset.js";
import {
  MouseEncoding,
  MouseTracking,
  type MouseEncodingValue,
  type MouseTrackingValue,
} from "../protocol/mouse.js";
import type { StationTerminalSize } from "../types.js";
import { buildVisibleRows, type VtRow } from "./rows.js";
import { type StationVtTheme, stationVtTheme } from "./theme.js";

const DEFAULT_FLUSH_INTERVAL_MS = 33;
const SYNC_OUTPUT_HOLD_MAX_MS = 1000;
// Raw feed tail kept for corruption dumps: enough history to replay how the
// visible grid got into its state, small enough for dozens of live panes.
const RAW_RING_LIMIT_CHARS = 128 * 1024;
const FRAGMENT_SCAN_MIN_INTERVAL_MS = 1_000;
// ANSI guts rendered as visible text — multi-param CSI bodies, truecolor SGR
// tails, OSC color replies, private-mode toggles. Heuristic by nature: a pane
// that PRINTS escape codes as text (log viewers) trips it, so it only ever
// counts and logs, never alerts.
const ESCAPE_FRAGMENT_PATTERN =
  /\[\??\d{1,4}(?:;\d{1,4}){1,7}[A-Za-z]|\b(?:38|48);[25];\d{1,3};\d{1,3};\d{1,3}m|;rgb:[0-9a-fA-F]{2}|\[\?\d{2,4}[hl]/;
// Production supplies the configured depth; this fallback keeps direct screen
// consumers aligned with the native workspace default.
const DEFAULT_SCROLLBACK_LINES = 10_000;
const DEFAULT_SCROLL_ON_OUTPUT: ScrollOnOutputMode = "freeze";
// Match xterm's internal resize clamp (and the bridge's) so the PTY and the
// screen model can never disagree on dimensions.
const MIN_COLS = 2;
const MIN_ROWS = 1;

export type StationVtScreenOptions = {
  size: StationTerminalSize;
  /** Normal-buffer history depth in lines; defaults to the native workspace default. */
  scrollback?: number;
  /** How the scroll position reacts to new output; defaults to `freeze`. */
  scrollOnOutput?: ScrollOnOutputMode;
  /** Injectable for deterministic coalescing tests. */
  flushIntervalMs?: number;
  /** Max hold for an open synchronized frame before the escape hatch flushes; injectable for tests. */
  syncHoldMaxMs?: number;
  theme?: StationVtTheme;
  /**
   * Terminal query replies (DA1/DA2/DSR/CPR/DECRQM from xterm, OSC 10/11 from
   * this store). These must be written back to the PTY verbatim: TUIs block
   * on them at startup.
   */
  onResponse?: (data: string) => void;
  /** Pane label attached to corruption telemetry and evidence dumps. */
  diagnosticsLabel?: string;
};

export type VtCursor = {
  /** Raw column; equals cols while a wrap is pending (DECAWM deferred wrap). */
  x: number;
  /** Viewport-relative row. */
  y: number;
};

/**
 * The child app's active mouse tracking flavor and report encoding. xterm
 * tracks the flavor (which DECSET of 9/1000/1002/1003 is on) but not the
 * encoding, so the SGR (1006) bit is tracked here alongside it.
 */
export type MouseProtocol = {
  /** DECSET flavor: x10=9, vt200=1000, drag=1002, any=1003. */
  tracking: MouseTrackingValue;
  /** SGR (DECSET 1006) vs the legacy X10 byte encoding. */
  encoding: MouseEncodingValue;
};

// xterm hands us tracking as one of a closed set of raw strings; translate it
// into the catalog at this seam (and null for "none") so no downstream file is
// coupled to xterm's vocabulary. Typed against xterm's union via `satisfies` so
// dropping or renaming a mode is a compile error and the lookup stays total (no
// undefined slipping past the null guard). Values match the engine's, so
// behavior is unchanged.
type XtermTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";
const XTERM_TRACKING = {
  none: null,
  x10: MouseTracking.X10,
  vt200: MouseTracking.Vt200,
  drag: MouseTracking.Drag,
  any: MouseTracking.Any,
} as const satisfies Record<XtermTrackingMode, MouseTrackingValue | null>;

export type VtBufferStats = {
  cols: number;
  rows: number;
  /** Lines pushed into scrollback (0 = none). */
  baseY: number;
  /** Total buffer lines including scrollback. */
  length: number;
};

// The engine (xterm) must not escape this type: everything above vt/ consumes
// this view, which is what keeps the conformance catalog and the renderer
// engine-agnostic if the engine is ever swapped.
export type StationVtScreen = {
  feed(data: string): void;
  resize(size: StationTerminalSize): void;
  /**
   * Style-merged spans for the rows currently in view (the live viewport, or
   * scrolled-back history when `getScrollOffset() > 0`). The cursor is only
   * composited at the live bottom.
   */
  buildRows(options?: { cursorVisible?: boolean }): VtRow[];
  /**
   * Scroll the viewport by `deltaLines` over scrollback; positive scrolls up
   * into history, negative back toward the live bottom. Clamped to the
   * available scrollback. Returns whether the position changed.
   */
  scrollBy(deltaLines: number): boolean;
  /** Jump back to the live bottom (offset 0). Returns whether it moved. */
  scrollToBottom(): boolean;
  /** Lines currently scrolled up from the live bottom (0 = at the bottom). */
  getScrollOffset(): number;
  /**
   * Plain text of an in-view row (honoring the scroll offset), optionally a
   * half-open column slice `[startCol, endCol)`. Wide chars are resolved by the
   * engine, so columns line up with the rendered grid. Powers selection/copy.
   */
  viewRowText(viewRow: number, startCol?: number, endCol?: number): string;
  /**
   * Whether an in-view row is a soft-wrap continuation of the row above it
   * (xterm `IBufferLine.isWrapped`). Lets copy join a wrapped logical line
   * back into one line instead of inserting a newline at each wrap boundary.
   */
  isViewRowWrapped(viewRow: number): boolean;
  /**
   * The cell column where the character at `charIndex` of `viewRowText(viewRow)`
   * begins. Inverse of slicing `viewRowText`: a wide char is one code point but
   * two cells, so selection geometry (cell columns) and word lookup (string
   * indices) need this to agree on CJK/emoji rows.
   */
  cellColumnForCharIndex(viewRow: number, charIndex: number): number;
  /**
   * The string index of the character occupying `cellCol` of `viewRowText`.
   * Unlike slicing `viewRowText`, a click on the *second* cell of a wide glyph
   * maps to that glyph, not the next character — so word selection is right on
   * either half of a CJK/emoji cell.
   */
  charIndexForCell(viewRow: number, cellCol: number): number;
  /**
   * Display width of the first glyph on an in-view row (2 for a leading wide
   * char, else 1). Lets copy detect the blank pad cell xterm leaves in the last
   * column of a soft-wrapped row when the next row's leading wide glyph couldn't
   * fit there — that pad would otherwise paste as a stray space.
   */
  firstGlyphWidth(viewRow: number): number;
  isCursorVisible(): boolean;
  /** DECSET 2004 state; decides paste wrapping. */
  isBracketedPasteEnabled(): boolean;
  /** Any DECSET mouse tracking mode is on (vim/htop want the wheel themselves). */
  isMouseReportingEnabled(): boolean;
  /**
   * The active mouse tracking flavor + report encoding, or null when the app
   * isn't requesting mouse events. Drives click/hover forwarding the way
   * isMouseReportingEnabled() drives wheel forwarding.
   */
  mouseProtocol(): MouseProtocol | null;
  /** DECCKM: arrow keys should be sent in application form (ESC O A vs ESC [ A). */
  isApplicationCursorKeys(): boolean;
  /** Kitty keyboard protocol state requested by the child app. */
  isKittyKeyboardEnabled(): boolean;
  /** Right-trimmed text of a visible row. */
  rowText(index: number): string;
  cursor(): VtCursor;
  isAltScreen(): boolean;
  bufferStats(): VtBufferStats;
  subscribe(listener: () => void): () => void;
  /**
   * The latest OSC 0/2 window title the child app set (trimmed, non-empty), or
   * undefined when no app has set one. This is the same signal terminal
   * emulators derive tab titles from: shells set it from precmd/PROMPT_COMMAND
   * and apps like vim/ssh/htop set it directly.
   */
  getTitle(): string | undefined;
  /** Subscribe to OSC title changes only (not per-frame screen updates). */
  onTitleChange(listener: () => void): () => void;
  /** Monotonic version bumped on each coalesced screen update. */
  getVersion(): number;
  /** Resolves after everything fed so far has been parsed. */
  whenIdle(): Promise<void>;
  /**
   * Forensic snapshot for corruption dumps: the visible grid plus the raw byte
   * tail that produced it (replayable offline through a fresh screen).
   */
  corruptionEvidence(): { rows: string[]; rawTail: string };
  /**
   * Test/diagnostic-only escape hatch to the underlying engine. Production
   * code must consume the view methods above instead.
   */
  readonly unsafeEngine: Terminal;
  dispose(): void;
};

export function createStationVtScreen(options: StationVtScreenOptions): StationVtScreen {
  const theme = options.theme ?? stationVtTheme;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const syncHoldMaxMs = options.syncHoldMaxMs ?? SYNC_OUTPUT_HOLD_MAX_MS;
  const terminal = new Terminal({
    cols: Math.max(options.size.cols, MIN_COLS),
    rows: Math.max(options.size.rows, MIN_ROWS),
    scrollback: options.scrollback ?? DEFAULT_SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  // Headless xterm defaults to Unicode 6 widths; OpenTUI measures with modern
  // tables. Without this, every cell after an emoji drifts one column.
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";

  const scrollOnOutput = options.scrollOnOutput ?? DEFAULT_SCROLL_ON_OUTPUT;
  let version = 0;
  let cursorVisible = true;
  // DECSET 1006 (SGR mouse encoding). xterm parses it but doesn't expose it via
  // `modes`, so track it ourselves the same way ?25 cursor visibility is.
  let sgrMouse = false;
  let disposed = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let lastFlushAt = 0;
  let syncHoldUntil: number | undefined;
  const rawRing = new ChunkRing(RAW_RING_LIMIT_CHARS);
  let lastFragmentScanAt = 0;

  const corruptionEvidence = (): { rows: string[]; rawTail: string } => ({
    rows: Array.from({ length: terminal.rows }, (_, index) => visibleRowText(index)),
    rawTail: rawRing.join(),
  });

  const reportCorruption = (
    kind: TerminalCorruptionKind,
    key?: string,
    detail?: Record<string, unknown>,
  ): void => {
    reportTerminalCorruption({
      kind,
      ...(options.diagnosticsLabel === undefined ? {} : { pane: options.diagnosticsLabel }),
      ...(key === undefined ? {} : { key }),
      ...(detail === undefined ? {} : { detail }),
    });
  };

  const visibleRowText = (index: number): string => {
    const buffer = terminal.buffer.active;
    return buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? "";
  };

  const scanForEscapeFragments = (): void => {
    const now = Date.now();
    if (now - lastFragmentScanAt < FRAGMENT_SCAN_MIN_INTERVAL_MS) {
      return;
    }
    lastFragmentScanAt = now;
    for (let index = 0; index < terminal.rows; index += 1) {
      const text = visibleRowText(index);
      const match = ESCAPE_FRAGMENT_PATTERN.exec(text);
      if (match !== null) {
        reportCorruption("escape_fragment", undefined, {
          row: index,
          excerpt: text.slice(Math.max(0, match.index - 8), match.index + 24),
        });
        if (options.diagnosticsLabel !== undefined) {
          writePaneEvidenceDump({
            pane: options.diagnosticsLabel,
            trigger: "escape_fragment",
            evidence: corruptionEvidence(),
          });
        }
        return;
      }
    }
  };
  // Lines scrolled up from the live bottom (0 = at the bottom).
  let scrollOffset = 0;
  let normalBufferIsSynchronizedFrame = false;
  let kittyKeyboardFlags = 0;
  // The most recent OSC 0/2 title; mirrors xterm's onTitleChange so the pane
  // border can show it without reaching into the engine.
  let oscTitle: string | undefined;
  const titleListeners = new Set<() => void>();
  const kittyKeyboardFlagStack: number[] = [];
  // For freeze/follow: a marker pinned to the top visible buffer line. It moves
  // with scrollback eviction, so it tracks how far content has scrolled even at
  // the scrollback cap where baseY plateaus. `shift` never anchors (it slides).
  let scrollAnchor: IMarker | undefined;
  const listeners = new Set<() => void>();

  const notifyListeners = (): void => {
    version += 1;
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const clampScrollOffset = (): void => {
    const baseY = terminal.buffer.active.baseY;
    if (scrollOffset > baseY) {
      scrollOffset = baseY;
    } else if (scrollOffset < 0) {
      scrollOffset = 0;
    }
  };

  const disposeScrollAnchor = (): void => {
    scrollAnchor?.dispose();
    scrollAnchor = undefined;
  };

  // Re-pin the anchor to the current top visible line after a manual scroll or
  // a resize. registerMarker is relative to the cursor, hence the offset math.
  const reanchorScroll = (): void => {
    disposeScrollAnchor();
    if (scrollOffset <= 0 || scrollOnOutput === "shift") {
      return;
    }
    const buffer = terminal.buffer.active;
    const topLine = buffer.baseY - scrollOffset;
    scrollAnchor = terminal.registerMarker(topLine - buffer.baseY - buffer.cursorY) ?? undefined;
  };

  // On new output while scrolled up, keep freeze pinned to the anchored line and
  // snap follow to the bottom. Correct even at the scrollback cap: baseY stops
  // growing, but the marker still moves as old lines are evicted.
  const applyScrollOnOutput = (): void => {
    if (scrollOffset <= 0 || scrollOnOutput === "shift" || scrollAnchor === undefined) {
      return;
    }
    if (scrollAnchor.line < 0) {
      // The anchored line was evicted past the start of scrollback; let the
      // clamp pin the view to the oldest line still held.
      disposeScrollAnchor();
      return;
    }
    const heldOffset = terminal.buffer.active.baseY - scrollAnchor.line;
    if (heldOffset <= scrollOffset) {
      return; // nothing new scrolled since we anchored
    }
    if (scrollOnOutput === "follow") {
      scrollOffset = 0;
      disposeScrollAnchor();
    } else {
      scrollOffset = heldOffset;
    }
  };

  const emitResponse = (data: string): void => {
    if (!disposed) {
      options.onResponse?.(data);
    }
  };

  // xterm answers DA1/DA2/DSR/CPR/DECRQM/DECRQSS internally; in headless the
  // replies surface only on onData and are dropped unless forwarded.
  terminal.onData(emitResponse);

  // xterm parses OSC 0/2 and emits the title here; coalesce blank titles to
  // undefined so the pane falls back rather than showing an empty border.
  terminal.onTitleChange((next) => {
    const trimmed = next.trim();
    const value = trimmed.length > 0 ? trimmed : undefined;
    if (value === oscTitle) {
      return;
    }
    oscTitle = value;
    for (const listener of [...titleListeners]) {
      listener();
    }
  });

  // Headless xterm does NOT answer OSC 10/11 color queries (the replying
  // ThemeService is browser-only), but termenv/lipgloss-based TUIs wait on
  // them for background detection. Answer with Station's theme; non-query
  // payloads fall through to xterm's own color tracking.
  terminal.parser.registerOscHandler(10, (data) => {
    if (data !== "?") {
      return false;
    }
    emitResponse(`\x1b]10;${toOscRgb(theme.foreground)}\x07`);
    return true;
  });
  terminal.parser.registerOscHandler(11, (data) => {
    if (data !== "?") {
      return false;
    }
    emitResponse(`\x1b]11;${toOscRgb(theme.background)}\x07`);
    return true;
  });

  // The headless buffer API does not expose DECTCEM cursor visibility, so
  // track ?25h/?25l ourselves; returning false keeps default processing.
  terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (paramListIncludes(params, DecMode.CursorVisible)) {
      cursorVisible = true;
    }
    if (paramListIncludes(params, DecMode.SgrMouse)) {
      sgrMouse = true;
    }
    return false;
  });
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (paramListIncludes(params, DecMode.CursorVisible)) {
      cursorVisible = false;
    }
    if (paramListIncludes(params, DecMode.SgrMouse)) {
      sgrMouse = false;
    }
    return false;
  });
  terminal.parser.registerCsiHandler({ final: CsiFinal.EraseInDisplay }, (params) => {
    const isNormalBufferFullScreenErase =
      params[0] === EraseInDisplayMode.EntireDisplay &&
      terminal.buffer.active.type === "normal";
    const isSynchronizedFullScreenErase =
      isNormalBufferFullScreenErase && terminal.modes.synchronizedOutputMode;
    // Archive the transition into an app-owned screen, not its subsequent repaint frames.
    // xterm consults this option only for ED2; flush restores it after parsing.
    terminal.options.scrollOnEraseInDisplay =
      isSynchronizedFullScreenErase && !normalBufferIsSynchronizedFrame;
    if (isNormalBufferFullScreenErase) {
      normalBufferIsSynchronizedFrame = isSynchronizedFullScreenErase;
    }
    return false;
  });
  // RIS and DECSTR both restore a visible cursor; without these a `reset`
  // after a cursor-hiding app leaves the pane cursorless forever. RIS also
  // clears mouse modes (xterm resets the flavor; clear our SGR bit to match).
  terminal.parser.registerEscHandler({ final: "c" }, () => {
    cursorVisible = true;
    sgrMouse = false;
    normalBufferIsSynchronizedFrame = false;
    return false;
  });
  terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
    cursorVisible = true;
    normalBufferIsSynchronizedFrame = false;
    return false;
  });
  terminal.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
    kittyKeyboardFlagStack.push(kittyKeyboardFlags);
    const flags = params[0];
    if (typeof flags === "number") {
      kittyKeyboardFlags = flags;
    }
    return true;
  });
  terminal.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
    const flags = params[0];
    kittyKeyboardFlags = typeof flags === "number" ? flags : 0;
    return true;
  });
  terminal.parser.registerCsiHandler({ prefix: "<", final: "u" }, () => {
    kittyKeyboardFlags = kittyKeyboardFlagStack.pop() ?? 0;
    return true;
  });
  terminal.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
    emitResponse(`\x1b[?${kittyKeyboardFlags}u`);
    return true;
  });

  // Sequences the engine swallows without handling are exactly where silent
  // corruption starts; count and log them. The public parser API has no
  // fallback hook, so this reaches into engine internals — an engine bump that
  // moves them turns detection off instead of breaking the screen.
  try {
    const parser = (
      terminal as unknown as {
        _core?: {
          _inputHandler?: {
            _parser?: {
              setCsiHandlerFallback(
                callback: (ident: number, params: { toArray(): unknown[] }) => void,
              ): void;
              setEscHandlerFallback(callback: (ident: number) => void): void;
              setOscHandlerFallback(
                callback: (identifier: number, action: string, data: string) => void,
              ): void;
              setDcsHandlerFallback(callback: (ident: number, action: string) => void): void;
            };
          };
        };
      }
    )._core?._inputHandler?._parser;
    if (parser === undefined) {
      // An engine bump moved the private path; make the silent loss of
      // unhandled-sequence detection observable instead of trusting empty counters.
      reportCorruption("parse_error", "fallback-wiring-unavailable");
    }
    parser?.setCsiHandlerFallback((ident, params) => {
      reportCorruption("unhandled_sequence", `csi:${ident}`, {
        family: "csi",
        ident,
        params: params.toArray(),
      });
    });
    parser?.setEscHandlerFallback((ident) => {
      reportCorruption("unhandled_sequence", `esc:${ident}`, { family: "esc", ident });
    });
    parser?.setOscHandlerFallback((identifier, action, data) => {
      if (action === "START") {
        reportCorruption("unhandled_sequence", `osc:${identifier}`, {
          family: "osc",
          ident: identifier,
          data: String(data).slice(0, 40),
        });
      }
    });
    parser?.setDcsHandlerFallback((ident, action) => {
      if (action === "HOOK") {
        reportCorruption("unhandled_sequence", `dcs:${ident}`, { family: "dcs", ident });
      }
    });
  } catch {
    reportCorruption("parse_error", "fallback-wiring-threw");
  }

  const flush = (): void => {
    flushTimer = undefined;
    if (disposed) {
      return;
    }
    // DECSET 2026 (synchronized output): between BSU and ESU the app is
    // mid-frame, so hold listener notification rather than snapshot a torn
    // buffer. Bounded so a client that never sends ESU cannot freeze the pane.
    if (terminal.modes.synchronizedOutputMode) {
      syncHoldUntil ??= Date.now() + syncHoldMaxMs;
      if (Date.now() < syncHoldUntil) {
        flushTimer = setTimeout(flush, flushIntervalMs);
        return;
      }
    }
    // Falling through means the mode is off or the escape-hatch deadline
    // passed; clear it either way so the NEXT synchronized frame re-arms a
    // fresh hold. Without this, a coalesced ESU+BSU that never let the mode be
    // observed off would reuse a stale (already-expired) deadline and tear; a
    // genuinely stuck frame just re-holds ~1s at a time.
    syncHoldUntil = undefined;
    terminal.options.scrollOnEraseInDisplay = false;
    lastFlushAt = Date.now();
    applyScrollOnOutput();
    clampScrollOffset();
    reanchorScroll();
    notifyListeners();
    scanForEscapeFragments();
  };

  const scheduleFlush = (): void => {
    if (disposed || flushTimer !== undefined) {
      return;
    }
    const elapsed = Date.now() - lastFlushAt;
    flushTimer = setTimeout(flush, elapsed >= flushIntervalMs ? 0 : flushIntervalMs - elapsed);
  };

  terminal.onWriteParsed(scheduleFlush);

  return {
    feed: (data) => {
      if (disposed) {
        return;
      }
      rawRing.push(data);
      // U+FFFD in the feed means bytes were already destroyed upstream (the
      // bridge's UTF-8 decode of split or invalid sequences).
      if (data.includes("�")) {
        let count = 0;
        for (const char of data) {
          if (char === "�") {
            count += 1;
          }
        }
        reportCorruption("replacement_char", undefined, { count });
      }
      terminal.write(data);
    },
    resize: (size) => {
      if (disposed) {
        return;
      }
      terminal.resize(Math.max(size.cols, MIN_COLS), Math.max(size.rows, MIN_ROWS));
      // Reflow moves line indices; keep the offset in range and re-pin the
      // anchor to the (possibly shifted) current top line.
      clampScrollOffset();
      reanchorScroll();
      scheduleFlush();
    },
    buildRows: (rowOptions) =>
      buildVisibleRows(terminal, {
        cursorVisible: rowOptions?.cursorVisible ?? cursorVisible,
        offset: scrollOffset,
      }),
    scrollBy: (deltaLines) => {
      if (disposed || deltaLines === 0) {
        return false;
      }
      const baseY = terminal.buffer.active.baseY;
      const next = Math.max(0, Math.min(baseY, scrollOffset + deltaLines));
      if (next === scrollOffset) {
        return false;
      }
      scrollOffset = next;
      reanchorScroll();
      notifyListeners();
      return true;
    },
    scrollToBottom: () => {
      if (disposed || scrollOffset === 0) {
        return false;
      }
      scrollOffset = 0;
      disposeScrollAnchor();
      notifyListeners();
      return true;
    },
    getScrollOffset: () => scrollOffset,
    viewRowText: (viewRow, startCol, endCol) => {
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(buffer.baseY - scrollOffset + viewRow);
      return line?.translateToString(false, startCol, endCol) ?? "";
    },
    isViewRowWrapped: (viewRow) => {
      const buffer = terminal.buffer.active;
      return buffer.getLine(buffer.baseY - scrollOffset + viewRow)?.isWrapped ?? false;
    },
    cellColumnForCharIndex: (viewRow, charIndex) => {
      if (charIndex <= 0) {
        return 0;
      }
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(buffer.baseY - scrollOffset + viewRow);
      if (line === undefined) {
        return charIndex;
      }
      // Walk cells the way translateToString builds the string: width-0 cells
      // continue a wide char and contribute no text; every other cell adds its
      // chars (blank → one space). Return the first non-continuation cell whose
      // preceding text already covers `charIndex`.
      const workCell = buffer.getNullCell();
      let chars = 0;
      for (let col = 0; col < terminal.cols; col += 1) {
        const cell = line.getCell(col, workCell);
        if (cell !== undefined && cell.getWidth() === 0) {
          continue;
        }
        if (chars >= charIndex) {
          return col;
        }
        chars += cell === undefined ? 1 : (cell.getChars() || " ").length;
      }
      return terminal.cols;
    },
    charIndexForCell: (viewRow, cellCol) => {
      if (cellCol <= 0) {
        return 0;
      }
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(buffer.baseY - scrollOffset + viewRow);
      if (line === undefined) {
        return cellCol;
      }
      // Walk glyph by glyph (width-0 cells continue a wide glyph). Return the
      // char index of the glyph whose cell span covers cellCol, so a click on
      // either half of a wide char maps to that char, not the next one.
      const workCell = buffer.getNullCell();
      let chars = 0;
      let glyphChars = 0;
      for (let col = 0; col <= cellCol && col < terminal.cols; col += 1) {
        const cell = line.getCell(col, workCell);
        if (cell !== undefined && cell.getWidth() === 0) {
          continue;
        }
        if (col === cellCol) {
          return chars;
        }
        glyphChars = chars;
        chars += cell === undefined ? 1 : (cell.getChars() || " ").length;
      }
      return glyphChars;
    },
    firstGlyphWidth: (viewRow) => {
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(buffer.baseY - scrollOffset + viewRow);
      const workCell = buffer.getNullCell();
      return line?.getCell(0, workCell)?.getWidth() ?? 1;
    },
    isCursorVisible: () => cursorVisible,
    isBracketedPasteEnabled: () => terminal.modes.bracketedPasteMode,
    isMouseReportingEnabled: () => terminal.modes.mouseTrackingMode !== "none",
    mouseProtocol: () => {
      const tracking = XTERM_TRACKING[terminal.modes.mouseTrackingMode];
      if (tracking === null) {
        return null;
      }
      return { tracking, encoding: sgrMouse ? MouseEncoding.Sgr : MouseEncoding.Legacy };
    },
    isApplicationCursorKeys: () => terminal.modes.applicationCursorKeysMode,
    isKittyKeyboardEnabled: () => kittyKeyboardFlags !== 0,
    rowText: (index) => visibleRowText(index),
    corruptionEvidence,
    cursor: () => {
      const buffer = terminal.buffer.active;
      return { x: buffer.cursorX, y: buffer.cursorY };
    },
    isAltScreen: () => terminal.buffer.active.type === "alternate",
    bufferStats: () => ({
      cols: terminal.cols,
      rows: terminal.rows,
      baseY: terminal.buffer.active.baseY,
      length: terminal.buffer.active.length,
    }),
    get unsafeEngine() {
      return terminal;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getTitle: () => oscTitle,
    onTitleChange: (listener) => {
      titleListeners.add(listener);
      return () => {
        titleListeners.delete(listener);
      };
    },
    getVersion: () => version,
    whenIdle: () => {
      if (disposed) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        terminal.write("", resolve);
      });
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      disposeScrollAnchor();
      listeners.clear();
      titleListeners.clear();
      terminal.dispose();
    },
  };
}

function paramListIncludes(params: (number | number[])[], target: number): boolean {
  return params.some((param) =>
    Array.isArray(param) ? param.includes(target) : param === target,
  );
}

/** "#d4d4d8" -> "rgb:d4d4/d4d4/d8d8" (xterm's 16-bit-per-channel reply form). */
function toOscRgb(hexColor: string): string {
  const r = hexColor.slice(1, 3);
  const g = hexColor.slice(3, 5);
  const b = hexColor.slice(5, 7);
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}
