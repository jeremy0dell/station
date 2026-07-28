import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "bun:test";
import { createPtyOutputCompatibility } from "./ptyOutputCompatibility.js";

const CSI = "\x1b[";
const policy = "top-region-scrollback" as const;

function regionScroll(bottom: number, count?: number): string {
  return `${CSI}1;${bottom}r${CSI}${count === undefined ? "" : count}S${CSI}r`;
}

function replacement(count: number): string {
  return `${CSI}r${CSI}999;1H${"\n".repeat(count)}${CSI}H`;
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

describe("top-region-scrollback output compatibility", () => {
  it("rewrites the captured B=50, k=3 sequence", () => {
    expect(transform([regionScroll(50, 3)])).toEqual({
      output: replacement(3),
      rewrites: 1,
    });
  });

  it("treats omitted and zero scroll counts as one", () => {
    expect(transform([regionScroll(50)]).output).toBe(replacement(1));
    expect(transform([regionScroll(50, 0)]).output).toBe(replacement(1));
  });

  it("handles every two-chunk split through the target sequence", () => {
    const input = regionScroll(50, 3);
    for (let split = 0; split <= input.length; split += 1) {
      expect(transform([input.slice(0, split), input.slice(split)])).toEqual({
        output: replacement(3),
        rewrites: 1,
      });
    }
  });

  it("handles a target split into one-byte PTY chunks", () => {
    expect(transform([...regionScroll(50, 3)])).toEqual({
      output: replacement(3),
      rewrites: 1,
    });
  });

  it("rewrites multiple matches in one chunk", () => {
    expect(transform([`before${regionScroll(50, 2)}middle${regionScroll(49)}after`])).toEqual({
      output: `before${replacement(2)}middle${replacement(1)}after`,
      rewrites: 2,
    });
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
    const captured = `${regionScroll(50, 3)}${CSI}48;1H${CSI}J`;
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
