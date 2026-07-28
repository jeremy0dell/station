import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "bun:test";
import { createPtyOutputCompatibility } from "./ptyOutputCompatibility.js";

const CSI = "\x1b[";
const policy = "top-region-scrollback" as const;

function regionScroll(bottom: number, count?: number): string {
  return `${CSI}1;${bottom}r${CSI}${count === undefined ? "" : count}S${CSI}r`;
}

function capturedRepaint(bottom: number, count?: number): string {
  const effectiveCount = count === undefined || count === 0 ? 1 : count;
  return `${regionScroll(bottom, count)}${CSI}${bottom - effectiveCount + 1};1H${CSI}J`;
}

function replacement(count: number): string {
  return `${CSI}r${CSI}999;1H${"\n".repeat(count)}${CSI}H`;
}

function rewrittenRepaint(bottom: number, count?: number): string {
  const effectiveCount = count === undefined || count === 0 ? 1 : count;
  return `${replacement(effectiveCount)}${CSI}${bottom - effectiveCount + 1};1H${CSI}J`;
}

function transform(chunks: string[], rows = 51): { output: string; rewrites: number } {
  const transformer = createPtyOutputCompatibility(policy);
  let output = "";
  let rewrites = 0;
  for (const chunk of chunks) {
    const result = transformer.transform(chunk, rows);
    output += result.data;
    rewrites += result.rewriteCount;
  }
  output += transformer.flush();
  return { output, rewrites };
}

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

function visibleRows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, index) =>
    buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? "",
  );
}

describe("PTY top-region scrollback compatibility", () => {
  it("passes the bare region-scroll prefix through byte-for-byte", () => {
    const input = regionScroll(50, 3);
    expect(transform([...input])).toEqual({ output: input, rewrites: 0 });
  });

  it("rewrites the full captured B=50, k=3 repaint", () => {
    expect(transform([capturedRepaint(50, 3)])).toEqual({
      output: rewrittenRepaint(50, 3),
      rewrites: 1,
    });
  });

  it("treats omitted and zero scroll counts as one", () => {
    expect(transform([capturedRepaint(50)]).output).toBe(rewrittenRepaint(50));
    expect(transform([capturedRepaint(50, 0)]).output).toBe(rewrittenRepaint(50, 0));
  });

  it("handles every two-chunk split through the captured repaint", () => {
    const input = capturedRepaint(50, 3);
    for (let split = 0; split <= input.length; split += 1) {
      expect(transform([input.slice(0, split), input.slice(split)])).toEqual({
        output: rewrittenRepaint(50, 3),
        rewrites: 1,
      });
    }
  });

  it("handles the captured repaint split into one-byte PTY chunks", () => {
    expect(transform([...capturedRepaint(50, 3)])).toEqual({
      output: rewrittenRepaint(50, 3),
      rewrites: 1,
    });
  });

  it("rewrites multiple matches in one chunk", () => {
    expect(transform([`before${capturedRepaint(50, 2)}middle${capturedRepaint(49)}after`])).toEqual({
      output: `before${rewrittenRepaint(50, 2)}middle${rewrittenRepaint(49)}after`,
      rewrites: 2,
    });
  });

  it("passes incomplete and non-matching repaint suffixes through byte-for-byte", () => {
    for (const input of [
      `${regionScroll(50, 3)}${CSI}48;1H`,
      `${regionScroll(50, 3)}${CSI}47;1H${CSI}J`,
      `${regionScroll(50, 3)}${CSI}48;1H${CSI}2J`,
    ]) {
      expect(transform([...input])).toEqual({ output: input, rewrites: 0 });
    }
  });

  for (const input of [
    regionScroll(0, 1),
    regionScroll(51, 1),
    regionScroll(52, 1),
    regionScroll(2, 3),
    `${CSI}2;50r${CSI}3S${CSI}r`,
    `${CSI}1;2;50r${CSI}3S${CSI}r`,
    `${CSI}1;50r${CSI}1;3S${CSI}r`,
    `${CSI}1;999999999999999999999999r${CSI}3S${CSI}r`,
    `${CSI}1;50r${CSI}999999999999999999999999S${CSI}r`,
  ]) {
    it("passes invalid or out-of-bounds input through byte-for-byte", () => {
      expect(transform([...input])).toEqual({ output: input, rewrites: 0 });
    });
  }

  it("passes unmatched and policy-disabled output through byte-for-byte", () => {
    const unmatched = `plain${CSI}1;50r${CSI}3S-not-reset`;
    expect(transform([...unmatched])).toEqual({ output: unmatched, rewrites: 0 });

    const disabled = createPtyOutputCompatibility();
    expect(disabled.transform(regionScroll(50, 3), 51)).toEqual({
      data: regionScroll(50, 3),
      rewriteCount: 0,
    });
    expect(disabled.flush()).toBe("");
  });

  it("rescues k history rows while preserving the captured final viewport", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => `captured-row-${index + 1}`);
    const initial = `${CSI}H${rows.join("\r\n")}`;
    const captured = capturedRepaint(50, 3);
    const transformed = transform([captured]).output;
    const originalTerminal = new Terminal({
      cols: 40,
      rows: 51,
      scrollback: 100,
      allowProposedApi: true,
    });
    const compatibleTerminal = new Terminal({
      cols: 40,
      rows: 51,
      scrollback: 100,
      allowProposedApi: true,
    });
    try {
      await write(originalTerminal, initial + captured);
      await write(compatibleTerminal, initial + transformed);

      expect(visibleRows(compatibleTerminal)).toEqual(visibleRows(originalTerminal));
      expect(originalTerminal.buffer.normal.baseY).toBe(0);
      expect(compatibleTerminal.buffer.normal.baseY).toBe(3);
      expect(
        Array.from({ length: 3 }, (_, index) =>
          compatibleTerminal.buffer.normal.getLine(index)?.translateToString(true),
        ),
      ).toEqual(rows.slice(0, 3));
    } finally {
      originalTerminal.dispose();
      compatibleTerminal.dispose();
    }
  });
});
