import type { SerializeAddon } from "@xterm/addon-serialize";
import type { IBuffer, IBufferCell, Terminal } from "@xterm/headless";
import { ControlByte } from "../terminal/protocol/controlBytes.js";
import { DecMode } from "../terminal/protocol/decset.js";
import { KittyKeyboard } from "../terminal/protocol/kitty.js";

const DECSC = `${ControlByte.Esc}7`;
const ALT_BUFFER_PREFIX = `${ControlByte.Csi}?1049h${ControlByte.Csi}H`;
const DEFAULT_CHARSET = "B";
const CHARSET_FLAGS = [
  "0",
  "4",
  "5",
  "6",
  "7",
  "=",
  "A",
  "B",
  "C",
  "E",
  "H",
  "K",
  "Q",
  "R",
  "Y",
  "Z",
] as const;
const CHARSET_INTERMEDIATES = ["(", ")", "*", "+"] as const;
const CHARSET_SLOT_BY_INTERMEDIATE = new Map<string, number>([
  ["(", 0],
  [")", 1],
  ["*", 2],
  ["+", 3],
  ["-", 1],
  [".", 2],
]);
const ANSI_LINE_FEED_MODE = 20;

const MissingDecMode = {
  SynchronizedOutput: 2026,
} as const;

const PrivateMode = {
  Ansi: 2,
  Wraparound: 7,
  Alternate: 47,
  AlternateClear: 1047,
  SaveCursor: 1048,
  SaveCursorAndAlternate: 1049,
} as const;

type BufferType = "normal" | "alternate";
type AlternateMode = 47 | 1047 | 1049;
type CharsetFlag = (typeof CHARSET_FLAGS)[number];

type CharsetState = {
  designations: [CharsetFlag, CharsetFlag, CharsetFlag, CharsetFlag];
  gl: number;
  resolved: CharsetFlag;
};

type SavedCursor = {
  x: number;
  y: number;
  sgr: string;
  charset: CharsetFlag;
};

type SgrAttributes = Pick<
  IBufferCell,
  | "getBgColor"
  | "getFgColor"
  | "isBgPalette"
  | "isBgRGB"
  | "isBlink"
  | "isBold"
  | "isDim"
  | "isFgPalette"
  | "isFgRGB"
  | "isInvisible"
  | "isInverse"
  | "isItalic"
  | "isOverline"
  | "isStrikethrough"
  | "isUnderline"
>;

type PinnedXtermAttributes = SgrAttributes & {
  extended: {
    underlineColor: number;
    urlId: number;
  };
  getUnderlineStyle(): number;
  getUnderlineVariantOffset(): number;
  isProtected(): number;
};

type PinnedXtermBuffer = {
  savedX: number;
  savedY: number;
  savedCurAttrData: PinnedXtermAttributes;
  scrollBottom: number;
  scrollTop: number;
  tabs: Record<string, boolean>;
};

type PinnedXtermTerminal = {
  _core: {
    _bufferService: {
      buffers: {
        alt: PinnedXtermBuffer;
        normal: PinnedXtermBuffer;
      };
    };
    _charsetService: {
      _charsets: Array<object | undefined>;
      charset: object | undefined;
      glevel: number;
    };
    coreService: {
      decPrivateModes: {
        cursorBlink?: boolean;
        cursorStyle?: "bar" | "block" | "underline";
      };
    };
    coreMouseService: {
      activeEncoding: "DEFAULT" | "SGR" | "SGR_PIXELS";
    };
    _inputHandler: {
      _curAttrData: PinnedXtermAttributes;
    };
  };
};

type ScrollRegion = { top: number; bottom: number };
type KittyKeyboardState = { flags: number; stack: number[] };

/**
 * Tracks terminal state omitted by addon-serialize and emits supplemental VT
 * needed to preserve future behavior across a semantic replay.
 */
export class TerminalRestoreState {
  readonly #terminal: Terminal;
  readonly #serializer: SerializeAddon;
  readonly #kittyKeyboard = new Map<BufferType, KittyKeyboardState>([
    ["normal", { flags: 0, stack: [] }],
    ["alternate", { flags: 0, stack: [] }],
  ]);
  readonly #savedBuffers = new Set<BufferType>();
  readonly #savedCharsets = new Map<BufferType, CharsetFlag>();
  readonly #subscriptions: Array<{ dispose(): void }>;
  readonly #tabStopWidth: number;
  #charset = defaultCharsetState();
  #streamBufferType: BufferType = "normal";
  #alternateMode: AlternateMode = PrivateMode.SaveCursorAndAlternate;
  #alternateActivationCharset: CharsetFlag = DEFAULT_CHARSET;
  #alternateActivationSgr = "";
  #cursorHidden = false;

  constructor(terminal: Terminal, serializer: SerializeAddon) {
    this.#terminal = terminal;
    this.#serializer = serializer;
    this.#tabStopWidth = terminal.options.tabStopWidth ?? 8;
    this.#savedCharsets.set("normal", DEFAULT_CHARSET);
    this.#savedCharsets.set("alternate", DEFAULT_CHARSET);
    const charsetSubscriptions: Array<{ dispose(): void }> = [];
    for (const [intermediate, slot] of CHARSET_SLOT_BY_INTERMEDIATE) {
      for (const charset of CHARSET_FLAGS) {
        charsetSubscriptions.push(
          terminal.parser.registerEscHandler({ intermediates: intermediate, final: charset }, () => {
            this.#designateCharset(slot, charset);
            return false;
          }),
        );
      }
    }
    this.#subscriptions = [
      ...charsetSubscriptions,
      terminal.parser.registerEscHandler({ final: "7" }, () => {
        this.#queueSave();
        return false;
      }),
      terminal.parser.registerEscHandler({ final: "8" }, () => {
        this.#restoreSavedCharset();
        return false;
      }),
      terminal.parser.registerCsiHandler({ final: "s" }, () => {
        this.#queueSave();
        return false;
      }),
      terminal.parser.registerCsiHandler({ final: "u" }, () => {
        this.#restoreSavedCharset();
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        this.#applyPrivateModes(params, true);
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        this.#applyPrivateModes(params, false);
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
        this.#applyKittyKeyboardSequence(">", params);
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
        this.#applyKittyKeyboardSequence("=", params);
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
        this.#applyKittyKeyboardSequence("<", params);
        return false;
      }),
      terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
        this.#softReset();
        return false;
      }),
      ...["n", "}"].map((final) =>
        terminal.parser.registerEscHandler({ final }, () => {
          this.#selectGl(2);
          return false;
        }),
      ),
      ...["o", "|"].map((final) =>
        terminal.parser.registerEscHandler({ final }, () => {
          this.#selectGl(3);
          return false;
        }),
      ),
      terminal.parser.registerEscHandler({ final: "~" }, () => {
        this.#selectGl(1);
        return false;
      }),
      ...["@", "G"].map((final) =>
        terminal.parser.registerEscHandler({ intermediates: "%", final }, () => {
          this.#charset.designations[0] = DEFAULT_CHARSET;
          this.#selectGl(0);
          return false;
        }),
      ),
      terminal.parser.registerEscHandler({ final: "c" }, () => {
        this.#resetStreamState();
        this.#resetSupplementalState();
        return false;
      }),
    ];
  }

  /** Writes through xterm so parser handlers and pinned engine state share one source of truth. */
  async write(data: string): Promise<void> {
    await new Promise<void>((resolve) => this.#terminal.write(data, resolve));
    this.#syncCharsetFromXterm();
  }

  /** Supplemental VT for callers that have no active hidden buffer to restore. */
  restoreSequence(beforeSynchronizedOutput = ""): string {
    this.#assertRepresentableAttributes();
    return this.#activeRestoreSequence(beforeSynchronizedOutput);
  }

  /**
   * Adds hidden-buffer restoration at addon-serialize's alternate-screen seam,
   * then appends active and global state.
   */
  restoreSerialization(serialized: string, beforeSynchronizedOutput = ""): string {
    this.#assertRepresentableAttributes();
    if (this.#bufferType() !== "alternate") {
      const hiddenAlternate = this.#hasHiddenAlternateState()
        ? `${ControlByte.Csi}?${PrivateMode.Alternate}h${ControlByte.Csi}H` +
          this.#bufferRestoreSequence("alternate", false) +
          `${ControlByte.Csi}?${PrivateMode.Alternate}l`
        : "";
      return serialized + hiddenAlternate + this.#activeRestoreSequence(beforeSynchronizedOutput);
    }

    const seam = serialized.indexOf(ALT_BUFFER_PREFIX);
    if (seam < 0) {
      throw new Error("Serialized alternate buffer is missing the expected activation seam.");
    }

    const hiddenNormal = this.#bufferRestoreSequence("normal", true);
    const activation =
      `${ControlByte.Csi}0m${this.#alternateActivationSgr}` +
      selectCharset(this.#alternateActivationCharset) +
      `${ControlByte.Csi}?${this.#alternateMode}h${ControlByte.Csi}H` +
      `${ControlByte.Csi}0m${selectCharset(DEFAULT_CHARSET)}`;
    return (
      serialized.slice(0, seam) +
      hiddenNormal +
      activation +
      serialized.slice(seam + ALT_BUFFER_PREFIX.length) +
      this.#activeRestoreSequence(beforeSynchronizedOutput)
    );
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#savedBuffers.clear();
  }

  #activeRestoreSequence(beforeSynchronizedOutput: string): string {
    const parts = [this.#bufferRestoreSequence(this.#bufferType(), false)];
    const terminal = this.#terminal as unknown as PinnedXtermTerminal;
    if (terminal._core.coreMouseService.activeEncoding === "SGR") {
      parts.push(`${ControlByte.Csi}?${DecMode.SgrMouse}h`);
    } else if (terminal._core.coreMouseService.activeEncoding === "SGR_PIXELS") {
      parts.push(`${ControlByte.Csi}?${DecMode.SgrPixels}h`);
    }
    parts.push(
      `${ControlByte.Csi}?${DecMode.CursorBlink}${this.#terminal.options.cursorBlink ? "h" : "l"}`,
      `${ControlByte.Csi}${ANSI_LINE_FEED_MODE}${this.#terminal.options.convertEol ? "h" : "l"}`,
      this.#cursorPresentationRestoreSequence(),
    );
    parts.push(
      `${ControlByte.Csi}?${DecMode.CursorVisible}${this.#cursorHidden ? "l" : "h"}`,
    );
    parts.push(beforeSynchronizedOutput);
    if (this.#terminal.modes.synchronizedOutputMode) {
      // Sync mode comes last so restoration bytes themselves are never held.
      parts.push(`${ControlByte.Csi}?${MissingDecMode.SynchronizedOutput}h`);
    }
    return parts.join("");
  }

  #bufferRestoreSequence(bufferType: BufferType, beforeAlternateActivation: boolean): string {
    const buffer = this.#buffer(bufferType);
    const pinnedBuffer = this.#pinnedBuffer(bufferType);
    const region = { top: pinnedBuffer.scrollTop + 1, bottom: pinnedBuffer.scrollBottom + 1 };
    const customRegion = region.top !== 1 || region.bottom !== this.#terminal.rows;
    const originMode = this.#terminal.modes.originMode;
    const restoreOrigin = originMode && !beforeAlternateActivation;
    const tabs = new Set(
      Object.entries(pinnedBuffer.tabs)
        .filter(([, enabled]) => enabled)
        .map(([column]) => Number(column)),
    );
    const saved = this.#savedBuffers.has(bufferType)
      ? this.#savedCursor(bufferType, buffer)
      : undefined;
    const current = {
      x: buffer.cursorX,
      y: buffer.cursorY,
      sgr:
        beforeAlternateActivation && this.#alternateMode === PrivateMode.SaveCursorAndAlternate
          ? (saved?.sgr ?? this.#currentSgr())
          : this.#currentSgr(),
    };
    if (
      restoreOrigin &&
      (current.y < region.top - 1 || current.y > region.bottom - 1)
    ) {
      throw new Error(
        `Cannot restore ${bufferType} cursor outside its origin-mode scroll region.`,
      );
    }
    const restoreBoundaryTab =
      current.x === this.#terminal.cols && tabs.has(this.#terminal.cols);
    this.#assertRestorableTabs(bufferType, tabs, restoreBoundaryTab);
    const customTabs = !setsEqual(
      tabs,
      defaultTabStops(this.#terminal.cols, this.#tabStopWidth),
      this.#terminal.cols,
    );
    const parts: string[] = [];

    if (originMode) {
      parts.push(`${ControlByte.Csi}?6l`);
    }
    if (customRegion) {
      parts.push(`${ControlByte.Csi}${region.top};${region.bottom}r`);
    }
    if (customTabs) {
      parts.push(`${ControlByte.Csi}3g`);
      for (const column of [...tabs].sort((left, right) => left - right)) {
        if (column < this.#terminal.cols) {
          parts.push(`${ControlByte.Csi}${column + 1}G${ControlByte.Esc}H`);
        }
      }
    }

    const activationSavesNormal =
      beforeAlternateActivation && this.#alternateMode === PrivateMode.SaveCursorAndAlternate;
    if (saved !== undefined && !activationSavesNormal) {
      if (saved.x === this.#terminal.cols) {
        parts.push(
          this.#wrapPendingSequence(
            buffer,
            saved.y,
            region,
            false,
            saved.sgr,
            selectCharset(saved.charset),
          ),
          DECSC,
        );
      } else {
        parts.push(
          this.#savedPosition(saved, region),
          `${ControlByte.Csi}0m`,
          saved.sgr,
          selectCharset(saved.charset),
          DECSC,
        );
      }
    }

    parts.push(this.#blankCellRestoreSequence(buffer, region));

    const activationCharset =
      activationSavesNormal && saved !== undefined
        ? selectCharset(saved.charset)
        : restoreCharset(this.#charset);
    if (restoreOrigin) {
      parts.push(`${ControlByte.Csi}?6h`);
    }
    parts.push(
      this.#position(current.y, current.x, region, restoreOrigin),
      `${ControlByte.Csi}0m`,
      current.sgr,
      activationCharset,
    );
    const restoredSavedCharset =
      !activationSavesNormal &&
      this.#charset.resolved !== this.#charset.designations[this.#charset.gl];
    if (restoredSavedCharset) {
      if (this.#savedCharsets.get(bufferType) !== this.#charset.resolved) {
        throw new Error(
          `Cannot restore ${bufferType} current charset from its saved cursor state.`,
        );
      }
      parts.push(
        `${ControlByte.Esc}8`,
        this.#position(current.y, current.x, region, restoreOrigin),
        `${ControlByte.Csi}0m`,
        current.sgr,
      );
    }
    if (current.x === this.#terminal.cols) {
      if (restoredSavedCharset) {
        throw new Error(
          "Cannot restore a wrap-pending cursor with DECRC-selected charset state.",
        );
      }
      parts.push(
        this.#wrapPendingSequence(
          buffer,
          current.y,
          region,
          restoreOrigin,
          current.sgr,
          activationCharset,
        ),
      );
      if (restoreBoundaryTab) {
        parts.push(`${ControlByte.Esc}H`);
      }
    }

    parts.push(this.#kittyKeyboardRestoreSequence(bufferType));

    return parts.join("");
  }

  #savedPosition(saved: SavedCursor, region: ScrollRegion): string {
    return this.#position(
      Math.max(0, Math.min(saved.y, this.#terminal.rows - 1)),
      saved.x,
      region,
      false,
    );
  }

  #savedCursor(bufferType: BufferType, buffer: IBuffer): SavedCursor {
    // Pinned xterm coordinates follow DECSC through IL/DL and reflow; public markers follow content.
    const saved = this.#pinnedBuffer(bufferType);
    const y = saved.savedY - buffer.baseY;
    if (y < 0) {
      throw new Error(`Cannot restore saved ${bufferType} cursor above retained history.`);
    }
    return {
      x: saved.savedX,
      y,
      sgr: sgrForAttributes(saved.savedCurAttrData),
      charset: this.#savedCharsets.get(bufferType) ?? DEFAULT_CHARSET,
    };
  }

  #pinnedBuffer(bufferType: BufferType): PinnedXtermBuffer {
    const terminal = this.#terminal as unknown as PinnedXtermTerminal;
    return bufferType === "alternate"
      ? terminal._core._bufferService.buffers.alt
      : terminal._core._bufferService.buffers.normal;
  }

  #assertRepresentableAttributes(): void {
    const terminal = this.#terminal as unknown as PinnedXtermTerminal;
    if (unsupportedAttribute(terminal._core._inputHandler._curAttrData)) {
      throw new Error("Cannot restore unsupported current terminal attributes.");
    }
    for (const bufferType of ["normal", "alternate"] as const) {
      if (
        this.#savedBuffers.has(bufferType) &&
        unsupportedAttribute(this.#pinnedBuffer(bufferType).savedCurAttrData)
      ) {
        throw new Error(`Cannot restore unsupported saved ${bufferType} terminal attributes.`);
      }
      const buffer = this.#buffer(bufferType);
      const cell = buffer.getNullCell();
      for (let row = 0; row < buffer.length; row += 1) {
        const line = buffer.getLine(row);
        for (let column = 0; column < this.#terminal.cols; column += 1) {
          const current = line?.getCell(column, cell);
          if (
            current !== undefined &&
            unsupportedAttribute(current as unknown as PinnedXtermAttributes)
          ) {
            throw new Error(
              `Cannot restore unsupported ${bufferType} buffer attributes at row ${row + 1}, column ${column + 1}.`,
            );
          }
        }
      }
    }
  }

  #wrapPendingSequence(
    buffer: IBuffer,
    y: number,
    region: ScrollRegion,
    originMode: boolean,
    currentSgr: string,
    currentCharset: string,
  ): string {
    const line = buffer.getLine(buffer.baseY + y);
    let column = this.#terminal.cols - 1;
    let cell = line?.getCell(column);
    while (cell?.getWidth() === 0 && column > 0) {
      column -= 1;
      cell = line?.getCell(column);
    }
    const chars = cell?.getChars() ?? "";
    if (cell === undefined || chars.length === 0) {
      throw new Error("Cannot restore a wrap-pending cursor without its final glyph.");
    }

    const parts = [
      `${ControlByte.Csi}?${PrivateMode.Wraparound}h`,
      `${ControlByte.Csi}4l`,
      this.#position(y, column, region, originMode),
      `${ControlByte.Csi}0m`,
      sgrForAttributes(cell),
      selectCharset(DEFAULT_CHARSET),
      chars,
      `${ControlByte.Csi}0m`,
      currentSgr,
      currentCharset,
    ];
    if (this.#terminal.modes.insertMode) {
      parts.push(`${ControlByte.Csi}4h`);
    }
    if (!this.#terminal.modes.wraparoundMode) {
      parts.push(`${ControlByte.Csi}?${PrivateMode.Wraparound}l`);
    }
    return parts.join("");
  }

  #blankCellRestoreSequence(buffer: IBuffer, region: ScrollRegion): string {
    const parts: string[] = [];
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.baseY + row);
      let column = 0;
      while (column < this.#terminal.cols) {
        const cell = line?.getCell(column);
        if (cell === undefined || cell.getWidth() !== 1 || cell.getChars() !== "") {
          column += 1;
          continue;
        }
        const background = backgroundKey(cell);
        let end = column + 1;
        while (end < this.#terminal.cols) {
          const next = line?.getCell(end);
          if (
            next === undefined ||
            next.getWidth() !== 1 ||
            next.getChars() !== "" ||
            backgroundKey(next) !== background
          ) {
            break;
          }
          end += 1;
        }
        parts.push(
          this.#position(row, column, region, false),
          `${ControlByte.Csi}0m`,
          sgrForBackground(cell),
          `${ControlByte.Csi}${end - column}X`,
        );
        column = end;
      }
    }
    return parts.join("");
  }

  #assertRestorableTabs(
    bufferType: BufferType,
    tabs: Set<number>,
    restoreBoundaryTab: boolean,
  ): void {
    const furthestTab = Math.max(-1, ...tabs);
    const probeCols = Math.max(furthestTab + 1, this.#terminal.cols + this.#tabStopWidth + 1);
    const source = new Set(tabs);
    extendTabStops(source, probeCols, this.#tabStopWidth);
    const replayed = new Set([...tabs].filter((column) => column < this.#terminal.cols));
    if (restoreBoundaryTab) {
      replayed.add(this.#terminal.cols);
    }
    extendTabStops(replayed, probeCols, this.#tabStopWidth);
    for (let column = this.#terminal.cols; column < probeCols; column += 1) {
      if (source.has(column) !== replayed.has(column)) {
        throw new Error(
          `Cannot restore ${bufferType} tab stops outside the current ${this.#terminal.cols}-column geometry.`,
        );
      }
    }
  }

  #applyPrivateModes(params: (number | number[])[], set: boolean): void {
    for (const param of primaryParams(params)) {
      if (param === DecMode.CursorVisible) {
        this.#cursorHidden = !set;
      } else if (set && param === PrivateMode.Ansi) {
        this.#charset.designations.fill(DEFAULT_CHARSET);
        this.#charset.resolved = DEFAULT_CHARSET;
      } else if (param === PrivateMode.SaveCursor) {
        if (set) {
          this.#queueSave();
        } else {
          this.#restoreSavedCharset();
        }
      } else if (param === PrivateMode.SaveCursorAndAlternate) {
        if (set) {
          this.#queueSave();
          this.#activateAlternateBuffer(param);
        } else {
          this.#deactivateAlternateBuffer();
          this.#restoreSavedCharset();
        }
      } else if (param === PrivateMode.Alternate || param === PrivateMode.AlternateClear) {
        if (set) {
          this.#activateAlternateBuffer(param);
        } else {
          this.#deactivateAlternateBuffer();
        }
      }
    }
  }

  #softReset(): void {
    const bufferType = this.#bufferType();
    this.#cursorHidden = false;
    this.#savedBuffers.add(bufferType);
    this.#charset = defaultCharsetState();
    this.#savedCharsets.set(bufferType, DEFAULT_CHARSET);
  }

  #currentSgr(): string {
    const buffer = this.#terminal.buffer.active;
    const row = buffer.baseY + buffer.cursorY;
    return [
      ...this.#serializer
        .serialize({ range: { start: row, end: row } })
        .matchAll(/\x1b\[[0-9;]*m/g),
    ]
      .map((match) => match[0])
      .join("");
  }

  #position(y: number, x: number, region: ScrollRegion, originMode: boolean): string {
    const row = originMode ? y - region.top + 2 : y + 1;
    return `${ControlByte.Csi}${Math.max(1, row)};${Math.min(x, this.#terminal.cols - 1) + 1}H`;
  }

  #buffer(bufferType: BufferType): IBuffer {
    return bufferType === "alternate"
      ? this.#terminal.buffer.alternate
      : this.#terminal.buffer.normal;
  }

  #bufferType(): BufferType {
    return this.#terminal.buffer.active.type === "alternate" ? "alternate" : "normal";
  }

  #resetSupplementalState(): void {
    for (const state of this.#kittyKeyboard.values()) {
      state.flags = 0;
      state.stack.length = 0;
    }
    this.#cursorHidden = false;
    this.#savedBuffers.clear();
  }

  #applyKittyKeyboardSequence(operator: "<" | ">" | "=", params: (number | number[])[]): void {
    const [first, second] = primaryParams(params);
    const state = this.#kittyKeyboard.get(this.#streamBufferType);
    if (state === undefined) {
      return;
    }
    if (operator === "<") {
      const count = Math.max(1, first ?? 1);
      if (count > state.stack.length) {
        state.flags = 0;
        state.stack.length = 0;
      } else {
        state.flags = state.stack[state.stack.length - count] ?? 0;
        state.stack.length -= count;
      }
      return;
    }
    if (operator === ">") {
      if (state.stack.length === KittyKeyboard.StackLimit) {
        state.stack.shift();
      }
      state.stack.push(state.flags);
      state.flags = first ?? 0;
      return;
    }
    const flags = first ?? 0;
    const mode = second ?? 1;
    if (mode === 2) {
      state.flags |= flags;
    } else if (mode === 3) {
      state.flags &= ~flags;
    } else {
      state.flags = flags;
    }
  }

  #kittyKeyboardRestoreSequence(bufferType: BufferType): string {
    const state = this.#kittyKeyboard.get(bufferType) ?? { flags: 0, stack: [] };
    const entries = [...state.stack, state.flags];
    const parts: string[] = [];
    const baseline = entries[0] ?? 0;
    if (baseline !== 0) {
      parts.push(`${ControlByte.Csi}=${baseline}u`);
    }
    for (const flags of entries.slice(1)) {
      parts.push(`${ControlByte.Csi}>${flags}u`);
    }
    return parts.join("");
  }

  #queueSave(): void {
    this.#syncCharsetFromXterm();
    this.#savedBuffers.add(this.#streamBufferType);
    this.#savedCharsets.set(this.#streamBufferType, this.#charset.resolved);
  }

  #activateAlternateBuffer(mode: AlternateMode): void {
    if (this.#streamBufferType === "normal") {
      this.#syncCharsetFromXterm();
      this.#alternateMode = mode;
      this.#alternateActivationCharset = this.#charset.resolved;
      const terminal = this.#terminal as unknown as PinnedXtermTerminal;
      this.#alternateActivationSgr = sgrForAttributes(
        terminal._core._inputHandler._curAttrData,
      );
      this.#streamBufferType = "alternate";
    }
  }

  #deactivateAlternateBuffer(): void {
    if (this.#streamBufferType === "normal") {
      return;
    }
    this.#streamBufferType = "normal";
  }

  #restoreSavedCharset(): void {
    this.#charset.resolved = this.#savedCharsets.get(this.#streamBufferType) ?? DEFAULT_CHARSET;
  }

  #selectGl(gl: number): void {
    this.#charset.gl = gl;
    this.#charset.resolved = this.#charset.designations[gl] ?? DEFAULT_CHARSET;
  }

  #designateCharset(slot: number, charset: CharsetFlag): void {
    this.#syncCharsetFromXterm();
    this.#charset.designations[slot] = charset;
    if (this.#charset.gl === slot) {
      this.#charset.resolved = charset;
    }
  }

  #resetStreamState(): void {
    this.#charset = defaultCharsetState();
    this.#streamBufferType = "normal";
    this.#alternateMode = PrivateMode.SaveCursorAndAlternate;
    this.#alternateActivationCharset = DEFAULT_CHARSET;
    this.#alternateActivationSgr = "";
    this.#savedBuffers.clear();
    this.#savedCharsets.set("normal", DEFAULT_CHARSET);
    this.#savedCharsets.set("alternate", DEFAULT_CHARSET);
  }

  #syncCharsetFromXterm(): void {
    const terminal = this.#terminal as unknown as PinnedXtermTerminal;
    const { _charsets, charset, glevel } = terminal._core._charsetService;
    this.#charset.gl = glevel;
    if (charset === _charsets[glevel]) {
      this.#charset.resolved = this.#charset.designations[glevel] ?? DEFAULT_CHARSET;
    }
  }

  #cursorPresentationRestoreSequence(): string {
    const terminal = this.#terminal as unknown as PinnedXtermTerminal;
    const { cursorBlink, cursorStyle } = terminal._core.coreService.decPrivateModes;
    if (cursorBlink === undefined && cursorStyle === undefined) {
      return "";
    }
    const base = cursorStyle === "underline" ? 3 : cursorStyle === "bar" ? 5 : 1;
    return `${ControlByte.Csi}${base + (cursorBlink === false ? 1 : 0)} q`;
  }

  #hasHiddenAlternateState(): boolean {
    const kitty = this.#kittyKeyboard.get("alternate");
    return (
      this.#savedBuffers.has("alternate") ||
      (kitty !== undefined && (kitty.flags !== 0 || kitty.stack.length > 0))
    );
  }
}

function defaultCharsetState(): CharsetState {
  return {
    designations: [DEFAULT_CHARSET, DEFAULT_CHARSET, DEFAULT_CHARSET, DEFAULT_CHARSET],
    gl: 0,
    resolved: DEFAULT_CHARSET,
  };
}

function defaultTabStops(cols: number, width: number): Set<number> {
  const stops = new Set<number>();
  for (let column = 0; column < cols; column += width) {
    stops.add(column);
  }
  return stops;
}

function extendTabStops(tabs: Set<number>, cols: number, width: number): void {
  let column = cols;
  while (column > 0 && !tabs.has(column)) {
    column -= 1;
  }
  for (; column < cols; column += width) {
    tabs.add(column);
  }
}

function setsEqual(left: Set<number>, right: Set<number>, cols: number): boolean {
  for (let column = 0; column < cols; column += 1) {
    if (left.has(column) !== right.has(column)) {
      return false;
    }
  }
  return true;
}

function selectCharset(charset: CharsetFlag): string {
  return `${ControlByte.Esc}(${charset}\x0f`;
}

function restoreCharset(state: CharsetState): string {
  return (
    state.designations
      .map((charset, index) => `${ControlByte.Esc}${CHARSET_INTERMEDIATES[index]}${charset}`)
      .join("") + lockingShift(state.gl)
  );
}

function lockingShift(gl: number): string {
  if (gl === 1) {
    return "\x0e";
  }
  if (gl === 2) {
    return `${ControlByte.Esc}n`;
  }
  if (gl === 3) {
    return `${ControlByte.Esc}o`;
  }
  return "\x0f";
}

function primaryParams(params: (number | number[])[]): number[] {
  return params.filter((param): param is number => !Array.isArray(param));
}

function unsupportedAttribute(attributes: PinnedXtermAttributes): boolean {
  return (
    Boolean(attributes.isProtected()) ||
    attributes.getUnderlineStyle() > 1 ||
    attributes.extended.underlineColor !== 0 ||
    attributes.getUnderlineVariantOffset() !== 0 ||
    attributes.extended.urlId !== 0
  );
}

function backgroundKey(attributes: SgrAttributes): string {
  if (attributes.isBgRGB()) {
    return `rgb:${attributes.getBgColor()}`;
  }
  if (attributes.isBgPalette()) {
    return `palette:${attributes.getBgColor()}`;
  }
  return "default";
}

function sgrForBackground(attributes: SgrAttributes): string {
  const background = attributes.getBgColor();
  if (attributes.isBgRGB()) {
    const red = (background >>> 16) & 0xff;
    const green = (background >>> 8) & 0xff;
    const blue = background & 0xff;
    return `${ControlByte.Csi}48;2;${red};${green};${blue}m`;
  }
  if (attributes.isBgPalette()) {
    const param =
      background >= 16
        ? `48;5;${background}`
        : String(background & 8 ? 100 + (background & 7) : 40 + (background & 7));
    return `${ControlByte.Csi}${param}m`;
  }
  return "";
}

function sgrForAttributes(attributes: SgrAttributes): string {
  const params: number[] = [];
  const foreground = attributes.getFgColor();
  if (attributes.isFgRGB()) {
    params.push(38, 2, (foreground >>> 16) & 0xff, (foreground >>> 8) & 0xff, foreground & 0xff);
  } else if (attributes.isFgPalette()) {
    params.push(
      ...(foreground >= 16
        ? [38, 5, foreground]
        : [foreground & 8 ? 90 + (foreground & 7) : 30 + (foreground & 7)]),
    );
  }
  const background = attributes.getBgColor();
  if (attributes.isBgRGB()) {
    params.push(48, 2, (background >>> 16) & 0xff, (background >>> 8) & 0xff, background & 0xff);
  } else if (attributes.isBgPalette()) {
    params.push(
      ...(background >= 16
        ? [48, 5, background]
        : [background & 8 ? 100 + (background & 7) : 40 + (background & 7)]),
    );
  }
  if (attributes.isInverse()) params.push(7);
  if (attributes.isBold()) params.push(1);
  if (attributes.isUnderline()) params.push(4);
  if (attributes.isOverline()) params.push(53);
  if (attributes.isBlink()) params.push(5);
  if (attributes.isInvisible()) params.push(8);
  if (attributes.isItalic()) params.push(3);
  if (attributes.isDim()) params.push(2);
  if (attributes.isStrikethrough()) params.push(9);
  return params.length === 0 ? "" : `${ControlByte.Csi}${params.join(";")}m`;
}
