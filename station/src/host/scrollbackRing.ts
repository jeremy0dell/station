import { ChunkRing } from "../terminal/chunkRing.js";
import { TerminalModeTracker } from "./modeTracker.js";

/**
 * FIFO of whole data-event chunks for attach replay. Over budget drops oldest
 * whole chunks, never partial events, and always keeps the newest chunk.
 *
 * Dropped chunks are scanned for sticky terminal modes (alt screen, mouse, …) so
 * a reattaching client can be told to re-establish them: otherwise an alt-screen
 * TUI whose setup scrolled past the budget would replay into a normal-screen VT.
 */
export class ScrollbackRing {
  readonly #modes = new TerminalModeTracker();
  readonly #ring: ChunkRing;

  constructor(maxBytes: number) {
    this.#ring = new ChunkRing(
      maxBytes,
      (chunk) => Buffer.byteLength(chunk, "utf8"),
      (dropped) => this.#modes.feed(dropped),
    );
  }

  push(chunk: string): void {
    this.#ring.push(chunk);
  }

  snapshot(): { scrollback: string[]; truncated: boolean } {
    // Prepend a mode-restore preamble so the modes set by dropped chunks are
    // re-established before the surviving chunks replay over them.
    const preamble = this.#modes.restoreSequence();
    const chunks = [...this.#ring.chunks()];
    const scrollback = preamble.length > 0 ? [preamble, ...chunks] : chunks;
    return { scrollback, truncated: this.#ring.evicted };
  }

  get byteLength(): number {
    return this.#ring.total;
  }
}
