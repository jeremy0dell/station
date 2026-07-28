import type { HostReplay, HostReplayEvent } from "@station/host";
import { TerminalModeTracker } from "./modeTracker.js";

type ScrollbackSize = { cols: number; rows: number };
type ScrollbackEntry = {
  before: ScrollbackSize;
  event: HostReplayEvent;
  bytes: number;
};

// Charge resize metadata so an output-free resize storm cannot grow replay without bound.
const RESIZE_EVENT_BYTES = 16;

/**
 * FIFO of whole data-event chunks and their production geometry for attach
 * replay. Over budget drops oldest whole chunks, never partial events, and
 * always keeps the newest chunk.
 *
 * Dropped chunks are scanned for sticky terminal modes (alt screen, mouse, …) so
 * a reattaching client can be told to re-establish them: otherwise an alt-screen
 * TUI whose setup scrolled past the budget would replay into a normal-screen VT.
 */
export class ScrollbackRing {
  readonly #modes = new TerminalModeTracker();
  readonly #entries: ScrollbackEntry[] = [];
  readonly #maxBytes: number;
  #currentSize: ScrollbackSize;
  #byteLength = 0;
  #evicted = false;

  constructor(maxBytes: number, initialSize: ScrollbackSize) {
    this.#maxBytes = maxBytes;
    this.#currentSize = { ...initialSize };
  }

  push(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.#retain({
      before: { ...this.#currentSize },
      event: { type: "data", data: chunk },
      bytes: Buffer.byteLength(chunk, "utf8"),
    });
  }

  resize(size: ScrollbackSize): void {
    if (size.cols === this.#currentSize.cols && size.rows === this.#currentSize.rows) {
      return;
    }
    this.#retain({
      before: { ...this.#currentSize },
      event: { type: "resize", ...size },
      bytes: RESIZE_EVENT_BYTES,
    });
    this.#currentSize = { ...size };
  }

  snapshot(): HostReplay {
    // Prepend a mode-restore preamble so the modes set by dropped chunks are
    // re-established before the surviving chunks replay over them.
    const preamble = this.#modes.restoreSequence();
    const initialSize = this.#entries[0]?.before ?? this.#currentSize;
    const events: HostReplayEvent[] = [];
    if (preamble.length > 0) {
      events.push({ type: "data", data: preamble });
    }
    for (const entry of this.#entries) {
      events.push(entry.event);
    }
    return {
      initialCols: initialSize.cols,
      initialRows: initialSize.rows,
      events,
      truncated: this.#evicted,
    };
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  #retain(entry: ScrollbackEntry): void {
    this.#entries.push(entry);
    this.#byteLength += entry.bytes;
    while (this.#byteLength > this.#maxBytes && this.#entries.length > 1) {
      const dropped = this.#entries.shift();
      if (dropped === undefined) {
        return;
      }
      this.#byteLength -= dropped.bytes;
      this.#evicted = true;
      if (dropped.event.type === "data") {
        this.#modes.feed(dropped.event.data);
      }
    }
  }
}
