import type { IBuffer, IBufferLine, Terminal } from "@xterm/headless";
import { ControlByte, CsiFinal } from "../terminal/protocol/controlBytes.js";
import { AnsiMode, DecMode } from "../terminal/protocol/decset.js";
import { KittyKeyboard } from "../terminal/protocol/kitty.js";
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
  `${ControlByte.Csi}?${DecMode.SaveCursorAndAlternate}h${ControlByte.Csi}H`;

type BufferType = "normal" | "alternate";
type AlternateMode =
  | typeof DecMode.Alternate
  | typeof DecMode.AlternateClear
  | typeof DecMode.SaveCursorAndAlternate;
type KittyKeyboardState = { flags: number; stack: number[] };
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

/** Exact terminal state that Station's restoration VT cannot currently represent. */
export class TerminalSnapshotUnsupportedStateError extends Error {}

/**
 * Restores Station-visible state that xterm's official serializer omits.
 * Exactness checks throw internally; the Host attachment boundary maps them to SafeError.
 */
export class TerminalSupplementalState {
  readonly #kittyKeyboard = new Map<BufferType, KittyKeyboardState>([
    ["normal", { flags: 0, stack: [] }],
    ["alternate", { flags: 0, stack: [] }],
  ]);
  readonly #savedBuffers = new Set<BufferType>();
  readonly #subscriptions: Array<{ dispose(): void }>;
  #alternateMode: AlternateMode = DecMode.SaveCursorAndAlternate;
  #bufferType: BufferType = "normal";
  #cursorVisible = true;

  constructor(private readonly terminal: Terminal) {
    this.#subscriptions = [
      ...(["<", ">", "="] as const).map((prefix) =>
        terminal.parser.registerCsiHandler({ prefix, final: "u" }, (params) => {
          this.#applyKittyKeyboard(prefix, params);
          return false;
        }),
      ),
      terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        this.#applyPrivateModes(params, true);
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        this.#applyPrivateModes(params, false);
        return false;
      }),
      terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
        this.#cursorVisible = true;
        this.#savedBuffers.add(this.#bufferType);
        return false;
      }),
      terminal.parser.registerCsiHandler({ final: "s" }, () => {
        this.#savedBuffers.add(this.#bufferType);
        return false;
      }),
      terminal.parser.registerEscHandler({ final: "7" }, () => {
        this.#savedBuffers.add(this.#bufferType);
        return false;
      }),
      terminal.parser.registerEscHandler({ final: "c" }, () => {
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
        "Cannot restore an alternate buffer entered without DECSET 1049.",
      );
    }
    const seam = serialized.indexOf(ALT_BUFFER_PREFIX);
    if (seam < 0) {
      throw new TerminalSnapshotUnsupportedStateError(
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
      parts.push(`${ControlByte.Csi}?${DecMode.SgrMouse}h`);
    }
    if (mouseEncoding === "SGR_PIXELS") {
      parts.push(`${ControlByte.Csi}?${DecMode.SgrPixels}h`);
    }
    parts.push(
      `${ControlByte.Csi}?${DecMode.CursorBlink}${this.terminal.options.cursorBlink ? "h" : "l"}`,
      `${ControlByte.Csi}${AnsiMode.LineFeedNewLine}${
        this.terminal.options.convertEol ? "h" : "l"
      }`,
      cursorPresentationSequence(pinned),
      `${ControlByte.Csi}?${DecMode.CursorVisible}${this.#cursorVisible ? "h" : "l"}`,
      this.#kittyKeyboardSequence(this.#bufferType),
      beforeSynchronizedOutput,
    );
    if (this.terminal.modes.synchronizedOutputMode) {
      // Sync mode comes last so restoration bytes themselves are never held.
      parts.push(`${ControlByte.Csi}?${DecMode.SynchronizedOutput}h`);
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
    if (movesCursor && buffer.cursorX >= this.terminal.cols) {
      throw new TerminalSnapshotUnsupportedStateError(
        `Cannot restore a wrap-pending ${bufferType} cursor.`,
      );
    }

    const parts: string[] = [];
    if (restoreOriginMode) {
      parts.push(`${ControlByte.Csi}?${DecMode.Origin}l`);
    }
    if (customRegion) {
      parts.push(`${ControlByte.Csi}${pinned.scrollTop + 1};${pinned.scrollBottom + 1}r`);
    }
    parts.push(blankBackgrounds, `${ControlByte.Csi}0m`, currentSgr);

    if (restoreOriginMode) {
      const row = buffer.cursorY - pinned.scrollTop + 1;
      if (row < 1 || row > pinned.scrollBottom - pinned.scrollTop + 1) {
        throw new TerminalSnapshotUnsupportedStateError(
          `Cannot restore the ${bufferType} cursor outside its origin region.`,
        );
      }
      parts.push(
        `${ControlByte.Csi}?${DecMode.Origin}h`,
        cursorPosition(row, buffer.cursorX),
      );
    } else if (movesCursor) {
      parts.push(cursorPosition(buffer.cursorY + 1, buffer.cursorX));
    }
    if (restoreSavedCursor) {
      parts.push(this.#savedCursorSequence(bufferType, currentSgr, restoreOriginMode));
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
    const parts = restoreOriginMode ? [`${ControlByte.Csi}?${DecMode.Origin}l`] : [];
    parts.push(
      `${ControlByte.Csi}0m`,
      xtermAttributeSgr(pinned.savedCurAttrData),
      cursorPosition(savedRow + 1, savedColumn),
      `${ControlByte.Esc}7`,
      `${ControlByte.Csi}0m`,
      currentSgr,
    );
    if (restoreOriginMode) {
      parts.push(`${ControlByte.Csi}?${DecMode.Origin}h`);
      const row = buffer.cursorY - pinned.scrollTop + 1;
      parts.push(cursorPosition(row, buffer.cursorX));
    } else {
      parts.push(cursorPosition(buffer.cursorY + 1, buffer.cursorX));
    }
    return parts.join("");
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
          cursorPosition(row + 1, column),
          `${ControlByte.Csi}0m`,
          xtermBackgroundSgr(cell),
          `${ControlByte.Csi}${end - column}${CsiFinal.EraseCharacter}`,
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
        "Cannot restore non-default terminal character sets.",
      );
    }
    if (
      this.#bufferType === "alternate" &&
      !this.#pinnedBuffer("normal").savedCurAttrData.isAttributeDefault()
    ) {
      throw new TerminalSnapshotUnsupportedStateError(
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
          `Cannot restore a saved ${savedBuffer} cursor.`,
        );
      }
      if (isUnsupportedXtermAttribute(this.#pinnedBuffer(savedBuffer).savedCurAttrData)) {
        throw new TerminalSnapshotUnsupportedStateError(
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
              `Cannot restore unsupported ${bufferType} attributes at row ${row + 1}, column ${column + 1}.`,
            );
          }
        }
      }
    }
    if (isUnsupportedXtermAttribute(pinned._core._inputHandler._curAttrData)) {
      throw new TerminalSnapshotUnsupportedStateError(
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
          `Cannot restore custom ${bufferType} tab stops.`,
        );
      }
    }
    for (const [column, enabled] of Object.entries(tabs)) {
      if (enabled && Number(column) >= this.terminal.cols && Number(column) % width !== 0) {
        throw new TerminalSnapshotUnsupportedStateError(
          `Cannot restore custom ${bufferType} tab stops.`,
        );
      }
    }
  }

  #applyPrivateModes(params: (number | number[])[], set: boolean): void {
    for (const mode of primaryParams(params)) {
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
    const [first, second] = primaryParams(params);
    if (operator === "<") {
      const count = Math.max(1, first ?? 1);
      state.flags = state.stack[state.stack.length - count] ?? 0;
      state.stack.length = Math.max(0, state.stack.length - count);
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

  #kittyKeyboardSequence(bufferType: BufferType): string {
    const state = this.#kittyKeyboard.get(bufferType);
    if (state === undefined) {
      return "";
    }
    const entries = [...state.stack, state.flags];
    const parts = entries[0] === 0 ? [] : [`${ControlByte.Csi}=${entries[0]}u`];
    for (const flags of entries.slice(1)) {
      parts.push(`${ControlByte.Csi}>${flags}u`);
    }
    return parts.join("");
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
    return [
      `${ControlByte.Csi}?${DecMode.Alternate}h`,
      kitty,
      restoreSavedCursor ? this.#savedCursorSequence("alternate", currentSgr, false) : "",
      `${ControlByte.Csi}?${DecMode.Alternate}l`,
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
    for (const state of this.#kittyKeyboard.values()) {
      state.flags = 0;
      state.stack.length = 0;
    }
  }
}

function primaryParams(params: (number | number[])[]): number[] {
  return params.filter((param): param is number => !Array.isArray(param));
}

function cursorPosition(row: number, column: number): string {
  return `${ControlByte.Csi}${row};${column + 1}H`;
}

function cursorPresentationSequence(terminal: PinnedXtermTerminal): string {
  const { cursorBlink, cursorStyle } = terminal._core.coreService.decPrivateModes;
  if (cursorBlink === undefined && cursorStyle === undefined) {
    return "";
  }
  const base = cursorStyle === "underline" ? 3 : cursorStyle === "bar" ? 5 : 1;
  return `${ControlByte.Csi}${base + (cursorBlink === false ? 1 : 0)} q`;
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
