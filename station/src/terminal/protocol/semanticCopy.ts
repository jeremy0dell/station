import {
  SEMANTIC_COPY_MAX_SEPARATOR_SPACES,
  SemanticCopySnapshotSchema,
  type SemanticCopySnapshot,
  type SemanticCopySnapshotEntry,
} from "@station/contracts";
import { type IMarker, Terminal } from "@xterm/headless";
import {
  CsiFinal,
  CsiIdentifier,
  EraseInDisplayMode,
  EscIdentifier,
} from "./controlBytes.js";

export type { SemanticCopySnapshot } from "@station/contracts";

const STATION_SEMANTIC_COPY_OSC = 6973;
const STATION_SEMANTIC_COPY_VERSION = 1;
const SEMANTIC_COPY_OSC_PREFIX = `station-copy;${STATION_SEMANTIC_COPY_VERSION};`;
const MAX_SEMANTIC_COPY_OSC_PAYLOAD_LENGTH =
  SEMANTIC_COPY_OSC_PREFIX.length + String(SEMANTIC_COPY_MAX_SEPARATOR_SPACES).length;

type SemanticCopyApplicationContinuation = Omit<SemanticCopySnapshotEntry, "row">;
type SemanticCopyBufferType = "normal" | "alternate";
export type SemanticCopyRestoreResult = { applied: number; dropped: number };

export type SemanticCopyState = {
  continuationForBufferRow(
    bufferType: SemanticCopyBufferType,
    bufferRow: number,
  ): SemanticCopyApplicationContinuation | undefined;
  snapshot(): SemanticCopySnapshot;
  restore(snapshot: SemanticCopySnapshot): SemanticCopyRestoreResult;
  clear(): void;
  dispose(): void;
};

type PinnedMarkerBuffer = {
  addMarker(row: number): IMarker;
};

type PinnedXtermTerminal = {
  _core: {
    _bufferService: {
      buffers: {
        normal: PinnedMarkerBuffer;
        alt: PinnedMarkerBuffer;
      };
    };
  };
};

type ContinuationEntry = SemanticCopyApplicationContinuation & {
  bufferType: SemanticCopyBufferType;
  marker: IMarker;
};

/**
 * Encodes a cooperating renderer's bounded v1 continuation claim as a zero-width OSC.
 */
export function semanticCopyContinuationMarker(separatorSpaces: number): string {
  if (
    !Number.isInteger(separatorSpaces) ||
    separatorSpaces < 0 ||
    separatorSpaces > SEMANTIC_COPY_MAX_SEPARATOR_SPACES
  ) {
    throw new RangeError(
      `Semantic-copy separator spaces must be an integer from 0 to ${SEMANTIC_COPY_MAX_SEPARATOR_SPACES}.`,
    );
  }
  return `\x1b]${STATION_SEMANTIC_COPY_OSC};station-copy;${STATION_SEMANTIC_COPY_VERSION};${separatorSpaces}\x1b\\`;
}

/**
 * Owns Station's untrusted semantic-copy OSC parser and row sidecar for one xterm model.
 *
 * Claims can only join a row, omit the cursor-derived visible prefix, and restore a bounded
 * count of ASCII separator spaces. Erase, buffer, reset, scrollback-eviction, and resize
 * behavior follows xterm markers; malformed and unsupported payloads are consumed and ignored.
 */
export function createSemanticCopyState(terminal: Terminal): SemanticCopyState {
  return new XtermSemanticCopyState(terminal);
}

class XtermSemanticCopyState implements SemanticCopyState {
  readonly #terminal: Terminal;
  readonly #markerBuffers: PinnedXtermTerminal["_core"]["_bufferService"]["buffers"];
  readonly #entries = new Set<ContinuationEntry>();
  readonly #subscriptions: Array<{ dispose(): void }>;
  #disposed = false;
  #indexDirty = true;
  #normalIndex = new Map<number, SemanticCopyApplicationContinuation>();
  #alternateIndex = new Map<number, SemanticCopyApplicationContinuation>();

  constructor(terminal: Terminal) {
    this.#terminal = terminal;
    const pinned = terminal as unknown as PinnedXtermTerminal;
    const markerBuffers = pinned._core?._bufferService?.buffers;
    if (
      typeof markerBuffers?.normal?.addMarker !== "function" ||
      typeof markerBuffers.alt?.addMarker !== "function"
    ) {
      throw new Error("The pinned xterm build does not expose semantic-copy marker buffers.");
    }
    this.#markerBuffers = markerBuffers;
    this.#subscriptions = [
      terminal.onWriteParsed(() => this.#invalidateIndex()),
      terminal.onResize(() => this.#invalidateIndex()),
      terminal.parser.registerOscHandler(STATION_SEMANTIC_COPY_OSC, (data) =>
        this.#handleOsc(data),
      ),
      terminal.parser.registerCsiHandler({ final: CsiFinal.EraseInLine }, () =>
        this.#clearActiveRow(),
      ),
      terminal.parser.registerCsiHandler({ final: CsiFinal.EraseCharacter }, () =>
        this.#clearActiveRow(),
      ),
      terminal.parser.registerCsiHandler({ final: CsiFinal.EraseInDisplay }, (params) =>
        this.#handleDisplayErase(params),
      ),
      terminal.parser.registerEscHandler(EscIdentifier.ResetToInitialState, () =>
        this.#handleReset(),
      ),
      terminal.parser.registerCsiHandler(CsiIdentifier.SoftTerminalReset, () =>
        this.#handleReset(),
      ),
    ];
  }

  continuationForBufferRow(
    bufferType: SemanticCopyBufferType,
    bufferRow: number,
  ): SemanticCopyApplicationContinuation | undefined {
    this.#rebuildIndex();
    return (bufferType === "normal" ? this.#normalIndex : this.#alternateIndex).get(
      bufferRow,
    );
  }

  snapshot(): SemanticCopySnapshot {
    this.#rebuildIndex();
    return {
      normal: this.#snapshotRows(this.#normalIndex),
      alternate: this.#snapshotRows(this.#alternateIndex),
    };
  }

  restore(snapshot: SemanticCopySnapshot): SemanticCopyRestoreResult {
    this.clear();
    try {
      const parsed = SemanticCopySnapshotSchema.parse(snapshot);
      let applied = 0;
      let dropped = 0;
      for (const bufferType of ["normal", "alternate"] as const) {
        for (const { row, leadingColumns, separatorSpaces } of parsed[bufferType]) {
          if (this.#addEntry(bufferType, row, { leadingColumns, separatorSpaces })) {
            applied += 1;
          } else {
            dropped += 1;
          }
        }
      }
      return { applied, dropped };
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  clear(): void {
    for (const entry of [...this.#entries]) {
      this.#removeEntry(entry);
    }
    this.#normalIndex.clear();
    this.#alternateIndex.clear();
    this.#indexDirty = false;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.clear();
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
  }

  #handleOsc(data: string): boolean {
    if (data.length > MAX_SEMANTIC_COPY_OSC_PAYLOAD_LENGTH) {
      return true;
    }
    const match = /^station-copy;1;(0|[1-9]\d{0,3})$/.exec(data);
    if (match === null) {
      return true;
    }
    const separatorSpaces = Number(match[1]);
    if (separatorSpaces > SEMANTIC_COPY_MAX_SEPARATOR_SPACES) {
      return true;
    }
    const bufferType = this.#activeBufferType();
    const buffer = this.#terminal.buffer.active;
    this.#addEntry(bufferType, buffer.baseY + buffer.cursorY, {
      leadingColumns: buffer.cursorX,
      separatorSpaces,
    });
    return true;
  }

  #clearActiveRow(): false {
    const bufferType = this.#activeBufferType();
    const buffer = this.#terminal.buffer.active;
    const row = buffer.baseY + buffer.cursorY;
    this.#clearRange(bufferType, row, row);
    return false;
  }

  #handleDisplayErase(params: (number | number[])[]): false {
    const bufferType = this.#activeBufferType();
    const buffer = this.#terminal.buffer.active;
    const firstViewportRow = buffer.baseY;
    const cursorRow = buffer.baseY + buffer.cursorY;
    const lastViewportRow = buffer.baseY + this.#terminal.rows - 1;
    const rawMode = params[0];
    const mode = Array.isArray(rawMode)
      ? rawMode[0]
      : (rawMode ?? EraseInDisplayMode.CursorToEnd);
    switch (mode) {
      case EraseInDisplayMode.CursorToEnd:
        this.#clearRange(bufferType, cursorRow, lastViewportRow);
        break;
      case EraseInDisplayMode.StartToCursor:
        this.#clearRange(bufferType, firstViewportRow, cursorRow);
        break;
      case EraseInDisplayMode.EntireDisplay:
        this.#clearRange(bufferType, firstViewportRow, lastViewportRow);
        break;
      case EraseInDisplayMode.SavedLines:
        // ED3 renumbers saved-line markers when xterm clears scrollback, so all
        // application continuations in that buffer must fail closed beforehand.
        this.#clearBuffer(bufferType);
        break;
      default:
        // Unknown erase modes must not leave a stale continuation on content
        // whose mutation semantics this observer cannot prove.
        this.#clearBuffer(bufferType);
    }
    return false;
  }

  #handleReset(): false {
    this.clear();
    return false;
  }

  #addEntry(
    bufferType: SemanticCopyBufferType,
    row: number,
    continuation: SemanticCopyApplicationContinuation,
  ): boolean {
    const buffer = this.#publicBuffer(bufferType);
    if (
      row < 0 ||
      row >= buffer.length ||
      continuation.leadingColumns > this.#terminal.cols
    ) {
      return false;
    }
    this.#clearRange(bufferType, row, row);
    const marker = this.#markerBuffer(bufferType).addMarker(row);
    const entry: ContinuationEntry = { bufferType, marker, ...continuation };
    this.#entries.add(entry);
    this.#invalidateIndex();
    marker.onDispose(() => {
      if (this.#entries.delete(entry)) {
        this.#invalidateIndex();
      }
    });
    return true;
  }

  #removeEntry(entry: ContinuationEntry): void {
    if (!this.#entries.delete(entry)) {
      return;
    }
    this.#invalidateIndex();
    if (!entry.marker.isDisposed) {
      entry.marker.dispose();
    }
  }

  #clearBuffer(bufferType: SemanticCopyBufferType): void {
    for (const entry of [...this.#entries]) {
      if (entry.bufferType === bufferType) {
        this.#removeEntry(entry);
      }
    }
  }

  #clearRange(
    bufferType: SemanticCopyBufferType,
    firstRow: number,
    lastRow: number,
  ): void {
    for (const entry of [...this.#entries]) {
      if (
        entry.bufferType === bufferType &&
        entry.marker.line >= firstRow &&
        entry.marker.line <= lastRow
      ) {
        this.#removeEntry(entry);
      }
    }
  }

  #rebuildIndex(): void {
    if (!this.#indexDirty) {
      return;
    }
    this.#normalIndex = new Map();
    this.#alternateIndex = new Map();
    for (const entry of this.#entries) {
      if (entry.marker.isDisposed || entry.marker.line < 0) {
        continue;
      }
      const value = {
        leadingColumns: entry.leadingColumns,
        separatorSpaces: entry.separatorSpaces,
      };
      (entry.bufferType === "normal" ? this.#normalIndex : this.#alternateIndex).set(
        entry.marker.line,
        value,
      );
    }
    this.#indexDirty = false;
  }

  #snapshotRows(
    index: ReadonlyMap<number, SemanticCopyApplicationContinuation>,
  ): SemanticCopySnapshotEntry[] {
    return [...index.entries()]
      .map(([row, continuation]) => ({ row, ...continuation }))
      .sort((left, right) => left.row - right.row);
  }

  #activeBufferType(): SemanticCopyBufferType {
    return this.#terminal.buffer.active.type === "alternate" ? "alternate" : "normal";
  }

  #markerBuffer(bufferType: SemanticCopyBufferType): PinnedMarkerBuffer {
    return bufferType === "normal" ? this.#markerBuffers.normal : this.#markerBuffers.alt;
  }

  #publicBuffer(bufferType: SemanticCopyBufferType) {
    return bufferType === "normal"
      ? this.#terminal.buffer.normal
      : this.#terminal.buffer.alternate;
  }

  #invalidateIndex(): void {
    this.#indexDirty = true;
  }
}
