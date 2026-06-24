/**
 * FIFO of whole data-event chunks for attach replay. Over budget drops oldest
 * whole chunks, never partial events, and always keeps the newest chunk.
 */
export class ScrollbackRing {
  readonly #chunks: string[] = [];
  #bytes = 0;
  #truncated = false;

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
      this.#bytes -= Buffer.byteLength(dropped, "utf8");
      this.#truncated = true;
    }
  }

  snapshot(): { scrollback: string[]; truncated: boolean } {
    return { scrollback: [...this.#chunks], truncated: this.#truncated };
  }

  get byteLength(): number {
    return this.#bytes;
  }
}
