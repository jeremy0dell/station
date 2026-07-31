import type { HostReplayEvent } from "@station/host";

type ScrollbackSize = { cols: number; rows: number };
type RawHostReplayEvent =
  | Extract<HostReplayEvent, { type: "data" }>
  | Extract<HostReplayEvent, { type: "resize" }>;
type ScrollbackEntry = {
  before: ScrollbackSize;
  event: RawHostReplayEvent;
  bytes: number;
};

export type ScrollbackSnapshot = {
  initialCols: number;
  initialRows: number;
  events: RawHostReplayEvent[];
  complete: boolean;
};

// Charge resize metadata so an output-free resize storm cannot grow replay without bound.
const RESIZE_EVENT_BYTES = 16;

/**
 * Bounded FIFO of whole data chunks and resize barriers. Once any entry is
 * evicted, callers must use semantic recovery instead of replaying partial VT.
 */
export class ScrollbackRing {
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

  snapshot(): ScrollbackSnapshot {
    const initialSize = this.#entries[0]?.before ?? this.#currentSize;
    return {
      initialCols: initialSize.cols,
      initialRows: initialSize.rows,
      events: this.#entries.map(({ event }) => event),
      complete: !this.#evicted,
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
    }
  }
}
