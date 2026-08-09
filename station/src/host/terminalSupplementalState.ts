import type { IBuffer, IBufferLine, Terminal } from "@xterm/headless";
import {
  CsiSequence,
  CursorPresentationStyle,
  type CursorPresentationStyleValue,
} from "../terminal/protocol/csi.js";
import { DecMode } from "../terminal/protocol/decset.js";
import { EscSequence } from "../terminal/protocol/esc.js";
import {
  CsiCommand,
  EscCommand,
  isPrimaryCsiParameter,
} from "../terminal/protocol/identifiers.js";
import {
  initialKittyKeyboardState,
  type KittyKeyboardOperation,
  type KittyKeyboardState,
  normalizeKittyFlagUpdateMode,
  reduceKittyKeyboardState,
  serializeKittyKeyboardState,
} from "../terminal/protocol/kitty.js";
import { MouseTrackingDecMode } from "../terminal/protocol/mouse.js";
import { VtPrefix } from "../terminal/protocol/syntax.js";
import {
  isUnsupportedBlankXtermAttribute,
  isUnsupportedXtermCellAttribute,
  isUnsupportedXtermAttribute,
  type PinnedXtermAttributes,
  type PinnedXtermCellAttributes,
  xtermAttributeSgr,
  xtermBackgroundKey,
  xtermBackgroundSgr,
} from "./xtermSnapshotAttributes.js";

const ALT_BUFFER_PREFIX =
  `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.SaveCursorAndAlternate}${CsiCommand.SetDecPrivateMode.final}` + CsiSequence.CursorHome;

type BufferType = "normal" | "alternate";
type AlternateMode =
  | typeof DecMode.Alternate
  | typeof DecMode.AlternateClear
  | typeof DecMode.SaveCursorAndAlternate;
type PinnedXtermBuffer = {
  savedCharset: object | undefined;
  savedCurAttrData: PinnedXtermAttributes;
  savedX: number;
  savedY: number;
  scrollBottom: number;
  scrollTop: number;
  tabs: Record<string, boolean>;
};

type PinnedXtermTerminal = {
  _core: {
    _bufferService: {
      buffers: { alt: PinnedXtermBuffer; normal: PinnedXtermBuffer };
    };
    _charsetService: {
      _charsets: Array<object | undefined>;
      charset: object | undefined;
      glevel: number;
    };
    _inputHandler: { _curAttrData: PinnedXtermAttributes };
    coreMouseService: { activeEncoding: "DEFAULT" | "SGR" | "SGR_PIXELS" };
    coreService: {
      decPrivateModes: {
        cursorBlink?: boolean;
        cursorStyle?: "bar" | "block" | "underline";
      };
    };
  };
};

/** Stable, content-free classification for terminal state Station cannot restore exactly. */
export type TerminalSnapshotUnsupportedStateDetail =
  | "alternate-mode"
  | "alternate-serialization"
  | "origin-cursor"
  | "buffer-transition"
  | "character-set"
  | "hidden-attributes"
  | "saved-cursor"
  | "saved-attributes"
  | "nonserializable-wrap"
  | "cell-attributes"
  | "current-attributes"
  | "custom-tabs"
  | "wrap-pending-cell";

/** Exactness failure carrying only a stable, content-free diagnostic detail. */
export class TerminalSnapshotUnsupportedStateError extends Error {
  constructor(
    readonly detail: TerminalSnapshotUnsupportedStateDetail,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Restores Station-visible state that xterm's official serializer omits.
 * Exactness checks throw internally; the Host attachment boundary maps them to SafeError.
 */
export class TerminalSupplementalState {
  readonly #kittyKeyboard = new Map<BufferType, KittyKeyboardState>([
    ["normal", initialKittyKeyboardState()],
    ["alternate", initialKittyKeyboardState()],
  ]);
  readonly #savedBuffers = new Set<BufferType>();
  readonly #subscriptions: Array<{ dispose(): void }>;
  #alternateMode: AlternateMode = DecMode.SaveCursorAndAlternate;
  #bufferType: BufferType = "normal";
  #cursorVisible = true;

  constructor(private readonly terminal: Terminal) {
    const kittyHandlers = [
      CsiCommand.KittyPopFlags,
      CsiCommand.KittyPushFlags,
      CsiCommand.KittyUpdateFlags,
    ] as const;
    this.#subscriptions = [
      ...kittyHandlers.map((identifier) =>
        terminal.parser.registerCsiHandler(identifier, (params) => {
          this.#applyKittyKeyboard(identifier.prefix, params);
          return false;
        }),
      ),
      terminal.parser.registerCsiHandler(CsiCommand.SetDecPrivateMode, (params) => {
        this.#applyPrivateModes(params, true);
        return false;
      }),
      terminal.parser.registerCsiHandler(CsiCommand.ResetDecPrivateMode, (params) => {
        this.#applyPrivateModes(params, false);
        return false;
      }),
      terminal.parser.registerCsiHandler(CsiCommand.SoftReset, () => {
        this.#cursorVisible = true;
        this.#savedBuffers.add(this.#bufferType);
        return false;
      }),
      terminal.parser.registerCsiHandler(CsiCommand.SaveCursor, () => {
        this.#savedBuffers.add(this.#bufferType);
        return false;
      }),
      terminal.parser.registerEscHandler(EscCommand.SaveCursor, () => {
        this.#savedBuffers.add(this.#bufferType);
        return false;
      }),
      terminal.parser.registerEscHandler(EscCommand.ResetToInitialState, () => {
        this.#reset();
        return false;
      }),
    ];
  }

  restoreSerialization(serialized: string, beforeSynchronizedOutput = ""): string {
    this.#assertSerializable();
    if (this.#bufferType === "normal") {
      return serialized + this.#activeRestoreSequence(beforeSynchronizedOutput);
    }
    if (this.#alternateMode !== DecMode.SaveCursorAndAlternate) {
      throw new TerminalSnapshotUnsupportedStateError(
        "alternate-mode",
        "Cannot restore an alternate buffer entered without DECSET 1049.",
      );
    }
    const seam = serialized.indexOf(ALT_BUFFER_PREFIX);
    if (seam < 0) {
      throw new TerminalSnapshotUnsupportedStateError(
        "alternate-serialization",
        "Serialized alternate buffer is missing its activation sequence.",
      );
    }
    // 1049 snapshots normal-buffer state, so hidden fixes must precede xterm's activation.
    const hiddenNormal =
      this.#bufferRestoreSequence(
        "normal",
        "",
        false,
      ) + this.#kittyKeyboardSequence("normal");
    return (
      serialized.slice(0, seam) +
      hiddenNormal +
      serialized.slice(seam) +
      this.#activeRestoreSequence(beforeSynchronizedOutput)
    );
  }

  /**
   * Build RIS-prefixed control-only VT for degraded live attachment. It restores
   * interaction modes and per-buffer Kitty stacks without cells, title, raw
   * history, or provider data, then establishes a valid active-buffer cursor
   * anchor for a cursor-relative child repaint.
   */
  liveResetSequence(): string {
    const parts: string[] = [EscSequence.ResetToInitialState];
    const normalKitty = this.#kittyKeyboardSequence("normal");
    const alternateKitty = this.#kittyKeyboardSequence("alternate");
    if (this.#bufferType === "alternate") {
      parts.push(
        normalKitty,
        `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${this.#alternateMode}${CsiCommand.SetDecPrivateMode.final}`,
        alternateKitty,
      );
    } else {
      if (alternateKitty.length > 0) {
        parts.push(
          `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.Alternate}${CsiCommand.SetDecPrivateMode.final}`,
          alternateKitty,
          `${VtPrefix.Csi}${CsiCommand.ResetDecPrivateMode.prefix}${DecMode.Alternate}${CsiCommand.ResetDecPrivateMode.final}`,
        );
      }
      parts.push(normalKitty);
    }

    const modes = this.terminal.modes;
    if (modes.applicationCursorKeysMode) {
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.ApplicationCursorKeys}${CsiCommand.SetDecPrivateMode.final}`);
    }
    if (modes.applicationKeypadMode) {
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.ApplicationKeypad}${CsiCommand.SetDecPrivateMode.final}`);
    }
    if (modes.bracketedPasteMode) {
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.BracketedPaste}${CsiCommand.SetDecPrivateMode.final}`);
    }
    const mouseTracking = modes.mouseTrackingMode;
    if (mouseTracking !== "none") {
      parts.push(
        `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${MouseTrackingDecMode[mouseTracking]}${CsiCommand.SetDecPrivateMode.final}`,
      );
    }
    const mouseEncoding = (this.terminal as unknown as PinnedXtermTerminal)._core
      .coreMouseService.activeEncoding;
    if (mouseEncoding === "SGR" || mouseEncoding === "SGR_PIXELS") {
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.SgrMouse}${CsiCommand.SetDecPrivateMode.final}`);
    }
    if (mouseEncoding === "SGR_PIXELS") {
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.SgrPixels}${CsiCommand.SetDecPrivateMode.final}`);
    }
    if (modes.sendFocusMode) {
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.FocusReporting}${CsiCommand.SetDecPrivateMode.final}`);
    }
    if (!modes.wraparoundMode) {
      parts.push(`${VtPrefix.Csi}${CsiCommand.ResetDecPrivateMode.prefix}${DecMode.Wraparound}${CsiCommand.ResetDecPrivateMode.final}`);
    }
    if (modes.reverseWraparoundMode) {
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.ReverseWraparound}${CsiCommand.SetDecPrivateMode.final}`);
    }
    parts.push(this.#activeCursorAnchorSequence());
    return parts.join("");
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
  }

  #activeRestoreSequence(beforeSynchronizedOutput: string): string {
    const pinned = this.terminal as unknown as PinnedXtermTerminal;
    const currentSgr = xtermAttributeSgr(pinned._core._inputHandler._curAttrData);
    const parts = [
      this.#hiddenAlternateStateSequence(currentSgr),
      this.#bufferRestoreSequence(
        this.#bufferType,
        currentSgr,
        this.terminal.modes.originMode,
      ),
    ];
    const mouseEncoding = pinned._core.coreMouseService.activeEncoding;
    if (mouseEncoding === "SGR" || mouseEncoding === "SGR_PIXELS") {
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.SgrMouse}${CsiCommand.SetDecPrivateMode.final}`);
    }
    if (mouseEncoding === "SGR_PIXELS") {
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.SgrPixels}${CsiCommand.SetDecPrivateMode.final}`);
    }
    parts.push(
      this.terminal.options.cursorBlink
        ? `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.CursorBlink}${CsiCommand.SetDecPrivateMode.final}`
        : `${VtPrefix.Csi}${CsiCommand.ResetDecPrivateMode.prefix}${DecMode.CursorBlink}${CsiCommand.ResetDecPrivateMode.final}`,
      this.terminal.options.convertEol
        ? CsiSequence.SetLineFeedNewLine
        : CsiSequence.ResetLineFeedNewLine,
      cursorPresentationSequence(pinned),
      this.#cursorVisible
        ? `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.CursorVisible}${CsiCommand.SetDecPrivateMode.final}`
        : `${VtPrefix.Csi}${CsiCommand.ResetDecPrivateMode.prefix}${DecMode.CursorVisible}${CsiCommand.ResetDecPrivateMode.final}`,
      this.#kittyKeyboardSequence(this.#bufferType),
      beforeSynchronizedOutput,
    );
    if (this.terminal.modes.synchronizedOutputMode) {
      // Sync mode comes last so restoration bytes themselves are never held.
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.SynchronizedOutput}${CsiCommand.SetDecPrivateMode.final}`);
    }
    return parts.join("");
  }

  #bufferRestoreSequence(
    bufferType: BufferType,
    currentSgr: string,
    restoreOriginMode: boolean,
  ): string {
    const buffer = this.#buffer(bufferType);
    const pinned = this.#pinnedBuffer(bufferType);
    const customRegion = pinned.scrollTop !== 0 || pinned.scrollBottom !== this.terminal.rows - 1;
    const blankBackgrounds = this.#blankBackgroundSequence(buffer);
    const restoreSavedCursor = this.#shouldRestoreSavedCursor(bufferType);
    const movesCursor =
      customRegion || blankBackgrounds.length > 0 || restoreOriginMode || restoreSavedCursor;

    const parts: string[] = [];
    if (restoreOriginMode) {
      parts.push(`${VtPrefix.Csi}${CsiCommand.ResetDecPrivateMode.prefix}${DecMode.Origin}${CsiCommand.ResetDecPrivateMode.final}`);
    }
    if (customRegion) {
      parts.push(
        `${VtPrefix.Csi}${pinned.scrollTop + 1};${pinned.scrollBottom + 1}${CsiCommand.SetScrollingRegion.final}`,
      );
    }
    parts.push(blankBackgrounds, CsiSequence.ResetGraphicsRendition, currentSgr);

    if (restoreOriginMode) {
      const row = buffer.cursorY - pinned.scrollTop + 1;
      if (row < 1 || row > pinned.scrollBottom - pinned.scrollTop + 1) {
        throw new TerminalSnapshotUnsupportedStateError(
          "origin-cursor",
          `Cannot restore the ${bufferType} cursor outside its origin region.`,
        );
      }
      parts.push(
        `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.Origin}${CsiCommand.SetDecPrivateMode.final}`,
        `${VtPrefix.Csi}${row};${buffer.cursorX + 1}${CsiCommand.CursorPosition.final}`,
      );
    } else if (movesCursor) {
      parts.push(
        `${VtPrefix.Csi}${buffer.cursorY + 1};${buffer.cursorX + 1}${CsiCommand.CursorPosition.final}`,
      );
    }
    if (restoreSavedCursor) {
      parts.push(this.#savedCursorSequence(bufferType, currentSgr, restoreOriginMode));
    }
    if (movesCursor && buffer.cursorX >= this.terminal.cols) {
      parts.push(this.#wrapPendingSequence(bufferType, currentSgr, restoreOriginMode));
    }
    return parts.join("");
  }

  #shouldRestoreSavedCursor(bufferType: BufferType): boolean {
    const recreatedByActiveAlternate =
      bufferType === "normal" &&
      this.#bufferType === "alternate" &&
      this.#alternateMode === DecMode.SaveCursorAndAlternate;
    return this.#savedBuffers.has(bufferType) && !recreatedByActiveAlternate;
  }

  #activeCursorAnchorSequence(): string {
    const buffer = this.#buffer(this.#bufferType);
    const pinned = this.#pinnedBuffer(this.#bufferType);
    const scrollTop = Math.max(0, Math.min(this.terminal.rows - 1, pinned.scrollTop));
    const scrollBottom = Math.max(
      scrollTop,
      Math.min(this.terminal.rows - 1, pinned.scrollBottom),
    );
    const column = Math.max(1, Math.min(this.terminal.cols, buffer.cursorX + 1));
    const parts: string[] = [];
    if (scrollTop !== 0 || scrollBottom !== this.terminal.rows - 1) {
      parts.push(
        `${VtPrefix.Csi}${scrollTop + 1};${scrollBottom + 1}${CsiCommand.SetScrollingRegion.final}`,
      );
    }
    const row = this.terminal.modes.originMode
      ? Math.max(1, Math.min(scrollBottom - scrollTop + 1, buffer.cursorY - scrollTop + 1))
      : Math.max(1, Math.min(this.terminal.rows, buffer.cursorY + 1));
    if (this.terminal.modes.originMode) {
      parts.push(
        `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.Origin}${CsiCommand.SetDecPrivateMode.final}`,
      );
    }
    parts.push(`${VtPrefix.Csi}${row};${column}${CsiCommand.CursorPosition.final}`);
    return parts.join("");
  }

  #savedCursorSequence(
    bufferType: BufferType,
    currentSgr: string,
    restoreOriginMode: boolean,
  ): string {
    const buffer = this.#buffer(bufferType);
    const pinned = this.#pinnedBuffer(bufferType);
    const savedRow = Math.min(
      this.terminal.rows - 1,
      Math.max(0, pinned.savedY - buffer.baseY),
    );
    const savedColumn = Math.min(this.terminal.cols - 1, Math.max(0, pinned.savedX));
    const parts = restoreOriginMode ? [`${VtPrefix.Csi}${CsiCommand.ResetDecPrivateMode.prefix}${DecMode.Origin}${CsiCommand.ResetDecPrivateMode.final}`] : [];
    parts.push(
      CsiSequence.ResetGraphicsRendition,
      xtermAttributeSgr(pinned.savedCurAttrData),
      `${VtPrefix.Csi}${savedRow + 1};${savedColumn + 1}${CsiCommand.CursorPosition.final}`,
      EscSequence.SaveCursor,
      CsiSequence.ResetGraphicsRendition,
      currentSgr,
    );
    if (restoreOriginMode) {
      parts.push(`${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.Origin}${CsiCommand.SetDecPrivateMode.final}`);
      const row = buffer.cursorY - pinned.scrollTop + 1;
      parts.push(`${VtPrefix.Csi}${row};${buffer.cursorX + 1}${CsiCommand.CursorPosition.final}`);
    } else {
      parts.push(
        `${VtPrefix.Csi}${buffer.cursorY + 1};${buffer.cursorX + 1}${CsiCommand.CursorPosition.final}`,
      );
    }
    return parts.join("");
  }

  #wrapPendingSequence(
    bufferType: BufferType,
    currentSgr: string,
    restoreOriginMode: boolean,
  ): string {
    const buffer = this.#buffer(bufferType);
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    const trailing = line?.getCell(this.terminal.cols - 1);
    let cell = trailing;
    let column = this.terminal.cols - 1;
    if (trailing?.getWidth() === 0) {
      cell = line?.getCell(this.terminal.cols - 2);
      column -= 1;
    }
    if (
      buffer.cursorX !== this.terminal.cols ||
      cell === undefined ||
      cell.getChars() === "" ||
      cell.getWidth() !== this.terminal.cols - column
    ) {
      throw new TerminalSnapshotUnsupportedStateError(
        "wrap-pending-cell",
        `Cannot restore the ${bufferType} wrap-pending trailing cell.`,
      );
    }
    const pinned = this.#pinnedBuffer(bufferType);
    const row = restoreOriginMode
      ? buffer.cursorY - pinned.scrollTop + 1
      : buffer.cursorY + 1;
    return [
      `${VtPrefix.Csi}${row};${column + 1}${CsiCommand.CursorPosition.final}`,
      CsiSequence.ResetGraphicsRendition,
      xtermAttributeSgr(cell),
      cell.getChars(),
      CsiSequence.ResetGraphicsRendition,
      currentSgr,
    ].join("");
  }

  #blankBackgroundSequence(buffer: IBuffer): string {
    const parts: string[] = [];
    for (let row = 0; row < this.terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.baseY + row);
      let column = 0;
      while (column < this.terminal.cols) {
        const cell = line?.getCell(column);
        // Repaint default blanks too; addon-serialize can leak prior BCE into them.
        // Width-zero cells are continuations of wide glyphs, not writable blanks.
        if (cell === undefined || cell.getWidth() !== 1 || cell.getChars() !== "") {
          column += 1;
          continue;
        }
        const background = xtermBackgroundKey(cell);
        let end = column + 1;
        while (end < this.terminal.cols) {
          const next = line?.getCell(end);
          if (
            next === undefined ||
            next.getWidth() !== 1 ||
            next.getChars() !== "" ||
            xtermBackgroundKey(next) !== background
          ) {
            break;
          }
          end += 1;
        }
        parts.push(
          `${VtPrefix.Csi}${row + 1};${column + 1}${CsiCommand.CursorPosition.final}`,
          CsiSequence.ResetGraphicsRendition,
          xtermBackgroundSgr(cell),
          `${VtPrefix.Csi}${end - column}${CsiCommand.EraseCharacters.final}`,
        );
        column = end;
      }
    }
    return parts.join("");
  }

  #assertSerializable(): void {
    const pinned = this.terminal as unknown as PinnedXtermTerminal;
    const activeBufferType =
      this.terminal.buffer.active.type === "alternate" ? "alternate" : "normal";
    if (activeBufferType !== this.#bufferType) {
      throw new TerminalSnapshotUnsupportedStateError(
        "buffer-transition",
        "Cannot restore terminal state after an untracked buffer transition.",
      );
    }
    const charset = pinned._core._charsetService;
    const buffers =
      this.#bufferType === "alternate"
        ? (["normal", "alternate"] as const)
        : (["normal"] as const);
    const buffersWithSavedState = new Set<BufferType>([
      ...buffers,
      ...this.#savedBuffers,
    ]);
    if (
      charset.glevel !== 0 ||
      charset.charset !== undefined ||
      charset._charsets.some((value) => value !== undefined) ||
      [...buffersWithSavedState].some(
        (bufferType) => this.#pinnedBuffer(bufferType).savedCharset !== undefined,
      )
    ) {
      throw new TerminalSnapshotUnsupportedStateError(
        "character-set",
        "Cannot restore non-default terminal character sets.",
      );
    }
    if (
      this.#bufferType === "alternate" &&
      !this.#pinnedBuffer("normal").savedCurAttrData.isAttributeDefault()
    ) {
      throw new TerminalSnapshotUnsupportedStateError(
        "hidden-attributes",
        "Cannot restore non-default hidden normal-buffer attributes.",
      );
    }
    for (const savedBuffer of this.#savedBuffers) {
      const recreatedByActiveAlternate =
        savedBuffer === "normal" &&
        this.#bufferType === "alternate" &&
        this.#alternateMode === DecMode.SaveCursorAndAlternate;
      const restorableHiddenAlternate =
        savedBuffer === "alternate" && this.#bufferType === "normal";
      if (
        !recreatedByActiveAlternate &&
        !restorableHiddenAlternate &&
        savedBuffer !== this.#bufferType
      ) {
        throw new TerminalSnapshotUnsupportedStateError(
          "saved-cursor",
          `Cannot restore a saved ${savedBuffer} cursor.`,
        );
      }
      if (isUnsupportedXtermAttribute(this.#pinnedBuffer(savedBuffer).savedCurAttrData)) {
        throw new TerminalSnapshotUnsupportedStateError(
          "saved-attributes",
          `Cannot restore unsupported saved ${savedBuffer} attributes.`,
        );
      }
    }
    for (const bufferType of buffers) {
      this.#assertDefaultTabs(bufferType);
      const buffer = this.#buffer(bufferType);
      const reusable = buffer.getNullCell();
      for (let row = 0; row < buffer.length; row += 1) {
        const line = buffer.getLine(row);
        if (
          line?.isWrapped &&
          !hasNaturallySerializableWrap(buffer.getLine(row - 1), line)
        ) {
          throw new TerminalSnapshotUnsupportedStateError(
            "nonserializable-wrap",
            `Cannot restore a non-serializable wrapped ${bufferType} line at row ${row + 1}.`,
          );
        }
        for (let column = 0; column < this.terminal.cols; column += 1) {
          const cell = line?.getCell(column, reusable) as
            | PinnedXtermCellAttributes
            | undefined;
          if (
            cell !== undefined &&
            (isUnsupportedXtermCellAttribute(cell) || isUnsupportedBlankXtermAttribute(cell))
          ) {
            throw new TerminalSnapshotUnsupportedStateError(
              "cell-attributes",
              `Cannot restore unsupported ${bufferType} attributes at row ${row + 1}, column ${column + 1}.`,
            );
          }
        }
      }
    }
    if (isUnsupportedXtermAttribute(pinned._core._inputHandler._curAttrData)) {
      throw new TerminalSnapshotUnsupportedStateError(
        "current-attributes",
        "Cannot restore unsupported current terminal attributes.",
      );
    }
  }

  #assertDefaultTabs(bufferType: BufferType): void {
    const width = this.terminal.options.tabStopWidth ?? 8;
    const tabs = this.#pinnedBuffer(bufferType).tabs;
    for (let column = 0; column < this.terminal.cols; column += 1) {
      if (Boolean(tabs[column]) !== (column % width === 0)) {
        throw new TerminalSnapshotUnsupportedStateError(
          "custom-tabs",
          `Cannot restore custom ${bufferType} tab stops.`,
        );
      }
    }
    for (const [column, enabled] of Object.entries(tabs)) {
      if (enabled && Number(column) >= this.terminal.cols && Number(column) % width !== 0) {
        throw new TerminalSnapshotUnsupportedStateError(
          "custom-tabs",
          `Cannot restore custom ${bufferType} tab stops.`,
        );
      }
    }
  }

  #applyPrivateModes(params: (number | number[])[], set: boolean): void {
    for (const mode of params.filter(isPrimaryCsiParameter)) {
      if (mode === DecMode.CursorVisible) {
        this.#cursorVisible = set;
      }
      if (set && (mode === DecMode.SaveCursor || mode === DecMode.SaveCursorAndAlternate)) {
        this.#savedBuffers.add(this.#bufferType);
      }
      if (
        mode !== DecMode.Alternate &&
        mode !== DecMode.AlternateClear &&
        mode !== DecMode.SaveCursorAndAlternate
      ) {
        continue;
      }
      if (set && this.#bufferType === "normal") {
        this.#alternateMode = mode;
        this.#bufferType = "alternate";
      } else if (!set) {
        this.#bufferType = "normal";
      }
    }
  }

  #applyKittyKeyboard(operator: "<" | ">" | "=", params: (number | number[])[]): void {
    const state = this.#kittyKeyboard.get(this.#bufferType);
    if (state === undefined) {
      return;
    }
    const [first, second] = params.filter(isPrimaryCsiParameter);
    let operation: KittyKeyboardOperation;
    switch (operator) {
      case "<":
        operation = { type: "pop", count: first ?? 1 };
        break;
      case ">":
        operation = { type: "push", flags: first ?? 0 };
        break;
      case "=":
        operation = {
          type: "update",
          flags: first ?? 0,
          mode: normalizeKittyFlagUpdateMode(second),
        };
        break;
    }
    this.#kittyKeyboard.set(
      this.#bufferType,
      reduceKittyKeyboardState(state, operation),
    );
  }

  #kittyKeyboardSequence(bufferType: BufferType): string {
    const state = this.#kittyKeyboard.get(bufferType);
    return state === undefined ? "" : serializeKittyKeyboardState(state);
  }

  #hiddenAlternateStateSequence(currentSgr: string): string {
    if (this.#bufferType !== "normal") {
      return "";
    }
    const kitty = this.#kittyKeyboardSequence("alternate");
    const restoreSavedCursor = this.#savedBuffers.has("alternate");
    if (kitty.length === 0 && !restoreSavedCursor) {
      return "";
    }
    const savedCursor = restoreSavedCursor
      ? this.#savedCursorSequence("alternate", currentSgr, false)
      : "";
    const wrapPending =
      restoreSavedCursor && this.#buffer("alternate").cursorX >= this.terminal.cols
        ? this.#wrapPendingSequence("alternate", currentSgr, false)
        : "";
    return [
      `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.Alternate}${CsiCommand.SetDecPrivateMode.final}`,
      kitty,
      savedCursor,
      wrapPending,
      `${VtPrefix.Csi}${CsiCommand.ResetDecPrivateMode.prefix}${DecMode.Alternate}${CsiCommand.ResetDecPrivateMode.final}`,
    ].join("");
  }

  #buffer(bufferType: BufferType): IBuffer {
    return bufferType === "alternate"
      ? this.terminal.buffer.alternate
      : this.terminal.buffer.normal;
  }

  #pinnedBuffer(bufferType: BufferType): PinnedXtermBuffer {
    const buffers = (this.terminal as unknown as PinnedXtermTerminal)._core._bufferService.buffers;
    return bufferType === "alternate" ? buffers.alt : buffers.normal;
  }

  #reset(): void {
    this.#alternateMode = DecMode.SaveCursorAndAlternate;
    this.#bufferType = "normal";
    this.#cursorVisible = true;
    this.#savedBuffers.clear();
    for (const bufferType of this.#kittyKeyboard.keys()) {
      this.#kittyKeyboard.set(bufferType, initialKittyKeyboardState());
    }
  }
}

function cursorPresentationSequence(terminal: PinnedXtermTerminal): string {
  const { cursorBlink, cursorStyle } = terminal._core.coreService.decPrivateModes;
  if (cursorBlink === undefined && cursorStyle === undefined) {
    return "";
  }
  return `${VtPrefix.Csi}${cursorPresentationStyle(cursorStyle, cursorBlink === false)}${CsiCommand.SelectCursorStyle.intermediates}${CsiCommand.SelectCursorStyle.final}`;
}

function cursorPresentationStyle(
  cursorStyle: "bar" | "block" | "underline" | undefined,
  steady: boolean,
): CursorPresentationStyleValue {
  switch (cursorStyle) {
    case "underline":
      return steady
        ? CursorPresentationStyle.SteadyUnderline
        : CursorPresentationStyle.BlinkingUnderline;
    case "bar":
      return steady
        ? CursorPresentationStyle.SteadyBar
        : CursorPresentationStyle.BlinkingBar;
    case "block":
    case undefined:
      return steady
        ? CursorPresentationStyle.SteadyBlock
        : CursorPresentationStyle.BlinkingBlock;
  }
}

function hasNaturallySerializableWrap(
  previous: IBufferLine | undefined,
  line: IBufferLine,
): boolean {
  // addon-serialize's fallback fill-and-erase wrap can leave glyphs behind.
  const first = line.getCell(0);
  const last = previous?.getCell(previous.length - 1);
  if (first === undefined || last === undefined || first.getChars() === "") {
    return false;
  }
  const background = xtermBackgroundKey(first);
  if (xtermBackgroundKey(last) !== background) {
    return false;
  }
  if (last.getChars() !== "" || last.getWidth() === 0) {
    return true;
  }
  const secondLast = previous?.getCell(previous.length - 2);
  return (
    first.getWidth() > 1 &&
    secondLast !== undefined &&
    (secondLast.getChars() !== "" || secondLast.getWidth() === 0) &&
    xtermBackgroundKey(secondLast) === background
  );
}
