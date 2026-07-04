/**
 * FIFO of whole string chunks bounded by a total measure. Over budget it drops
 * oldest whole chunks (never partial), always keeps the newest, and reports
 * whether anything was dropped. `measure` defaults to code-unit length; pass
 * `Buffer.byteLength` for a byte budget. `onEvict` observes dropped chunks (e.g.
 * to track sticky terminal modes before they scroll out).
 */
export class ChunkRing {
  readonly #chunks: string[] = [];
  #total = 0;
  #evicted = false;

  constructor(
    private readonly maxTotal: number,
    private readonly measure: (chunk: string) => number = (chunk) => chunk.length,
    private readonly onEvict?: (chunk: string) => void,
  ) {}

  push(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.#chunks.push(chunk);
    this.#total += this.measure(chunk);
    while (this.#total > this.maxTotal && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped === undefined) {
        break;
      }
      this.onEvict?.(dropped);
      this.#total -= this.measure(dropped);
      this.#evicted = true;
    }
  }

  chunks(): readonly string[] {
    return this.#chunks;
  }

  join(): string {
    return this.#chunks.join("");
  }

  get evicted(): boolean {
    return this.#evicted;
  }

  get total(): number {
    return this.#total;
  }
}
