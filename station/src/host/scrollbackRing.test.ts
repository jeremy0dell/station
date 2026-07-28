import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "bun:test";
import { ScrollbackRing } from "./scrollbackRing.js";

const SIZE = { cols: 80, rows: 24 };

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

describe("ScrollbackRing", () => {
  it("keeps all entries while under budget and reports complete", () => {
    const ring = new ScrollbackRing(1024, SIZE);
    ring.push("alpha");
    ring.push("beta");
    expect(ring.snapshot()).toEqual({
      initialCols: 80,
      initialRows: 24,
      events: [
        { type: "data", data: "alpha" },
        { type: "data", data: "beta" },
      ],
      complete: true,
    });
  });

  it("drops oldest whole entries past the byte budget and reports incomplete", () => {
    const ring = new ScrollbackRing(10, SIZE);
    ring.push("aaaaa");
    ring.push("bbbbb");
    ring.push("ccccc");
    expect(ring.snapshot()).toEqual({
      initialCols: 80,
      initialRows: 24,
      events: [
        { type: "data", data: "bbbbb" },
        { type: "data", data: "ccccc" },
      ],
      complete: false,
    });
  });

  it("starts retained entries at their production geometry", () => {
    const ring = new ScrollbackRing(5, { cols: 10, rows: 4 });
    ring.push("aaaaa");
    ring.resize({ cols: 5, rows: 4 });
    ring.push("bbbbb");

    expect(ring.snapshot()).toEqual({
      initialCols: 5,
      initialRows: 4,
      events: [{ type: "data", data: "bbbbb" }],
      complete: false,
    });
  });

  it("never drops the only newest entry even when it exceeds the budget", () => {
    const ring = new ScrollbackRing(4, SIZE);
    ring.push("this-one-entry-is-huge");
    expect(ring.snapshot()).toMatchObject({
      events: [{ type: "data", data: "this-one-entry-is-huge" }],
      complete: true,
    });
  });

  it("ignores empty chunks", () => {
    const ring = new ScrollbackRing(1024, SIZE);
    ring.push("");
    expect(ring.snapshot()).toEqual({
      initialCols: 80,
      initialRows: 24,
      events: [],
      complete: true,
    });
  });

  it("never turns incomplete raw bytes into a synthetic replay", () => {
    const ring = new ScrollbackRing(10, SIZE);
    ring.push("\x1b[?1049h");
    ring.push("aaaaa");
    ring.push("bbbbb");

    expect(ring.snapshot()).toMatchObject({
      complete: false,
      events: [
        { type: "data", data: "aaaaa" },
        { type: "data", data: "bbbbb" },
      ],
    });
  });

  it("replays retained data at the exact geometry that produced it", async () => {
    const ring = new ScrollbackRing(1024, { cols: 10, rows: 4 });
    ring.push("1234567890\rX");
    ring.resize({ cols: 5, rows: 4 });
    ring.push("\rY");
    const replay = ring.snapshot();

    expect(replay.events).toEqual([
      { type: "data", data: "1234567890\rX" },
      { type: "resize", cols: 5, rows: 4 },
      { type: "data", data: "\rY" },
    ]);

    const terminal = new Terminal({
      cols: replay.initialCols,
      rows: replay.initialRows,
      allowProposedApi: true,
    });
    try {
      for (const event of replay.events) {
        if (event.type === "resize") {
          terminal.resize(event.cols, event.rows);
        } else {
          await write(terminal, event.data);
        }
      }
      const buffer = terminal.buffer.active;
      expect(buffer.getLine(buffer.baseY)?.translateToString(true)).toBe("Y2345");
      expect(buffer.getLine(buffer.baseY + 1)?.translateToString(true)).toBe("");
      expect({ x: buffer.cursorX, y: buffer.cursorY }).toEqual({ x: 1, y: 0 });
    } finally {
      terminal.dispose();
    }
  });

  it("preserves resize-only paths that mutate xterm reflow", async () => {
    const ring = new ScrollbackRing(1024, { cols: 10, rows: 4 });
    const source = new Terminal({ cols: 10, rows: 4, allowProposedApi: true });
    ring.push("1234567890abcdefghij");
    await write(source, "1234567890abcdefghij");
    ring.resize({ cols: 5, rows: 4 });
    source.resize(5, 4);
    ring.resize({ cols: 10, rows: 4 });
    source.resize(10, 4);

    const replay = ring.snapshot();
    const target = new Terminal({
      cols: replay.initialCols,
      rows: replay.initialRows,
      allowProposedApi: true,
    });
    try {
      for (const event of replay.events) {
        if (event.type === "resize") {
          target.resize(event.cols, event.rows);
        } else {
          await write(target, event.data);
        }
      }
      const state = (terminal: Terminal) => {
        const buffer = terminal.buffer.active;
        return {
          lines: Array.from({ length: buffer.length }, (_, index) =>
            buffer.getLine(index)?.translateToString(true),
          ),
          cursor: { x: buffer.cursorX, y: buffer.cursorY },
        };
      };
      expect(replay.events).toEqual([
        { type: "data", data: "1234567890abcdefghij" },
        { type: "resize", cols: 5, rows: 4 },
        { type: "resize", cols: 10, rows: 4 },
      ]);
      expect(state(target)).toEqual(state(source));
    } finally {
      source.dispose();
      target.dispose();
    }
  });

  it("charges resize storms against the replay budget", () => {
    const ring = new ScrollbackRing(64, { cols: 10, rows: 4 });
    for (let index = 0; index < 10_000; index += 1) {
      ring.resize({ cols: index % 2 === 0 ? 5 : 6, rows: 4 });
    }

    const replay = ring.snapshot();
    expect(replay.events).toHaveLength(4);
    expect(replay.events.at(-1)).toEqual({ type: "resize", cols: 6, rows: 4 });
    expect(replay.complete).toBe(false);
    expect(ring.byteLength).toBe(64);
  });
});
