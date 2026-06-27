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
  readonly #chunks: string[] = [];
  #bytes = 0;
  #truncated = false;
  readonly #modes = new TerminalModeTracker();

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += Buffer.byteLength(chunk, "utf8");
    while (this.#bytes > this.maxBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped === undefined) {
        break;
      }
      this.#modes.feed(dropped);
      this.#bytes -= Buffer.byteLength(dropped, "utf8");
      this.#truncated = true;
    }
  }

  snapshot(): { scrollback: string[]; truncated: boolean } {
    // Prepend a mode-restore preamble so the modes set by dropped chunks are
    // re-established before the surviving chunks replay over them.
    const preamble = this.#modes.restoreSequence();
    const scrollback = preamble.length > 0 ? [preamble, ...this.#chunks] : [...this.#chunks];
    return { scrollback, truncated: this.#truncated };
  }

  get byteLength(): number {
    return this.#bytes;
  }
}
