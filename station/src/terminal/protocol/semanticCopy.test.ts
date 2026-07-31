import { describe, expect, it } from "bun:test";
import { createStationVtScreen } from "../vt/screen.js";
import {
  createSemanticCopyState,
  semanticCopyContinuationMarker,
} from "./semanticCopy.js";
import { Terminal } from "@xterm/headless";

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

describe("Station semantic copy protocol", () => {
  it("encodes the exact bounded v1 marker", () => {
    expect(semanticCopyContinuationMarker(2)).toBe(
      "\x1b]6973;station-copy;1;2\x1b\\",
    );
    expect(semanticCopyContinuationMarker(1024)).toBe(
      "\x1b]6973;station-copy;1;1024\x1b\\",
    );
    for (const invalid of [-1, 1.5, 1025]) {
      expect(() => semanticCopyContinuationMarker(invalid)).toThrow(/must be an integer/);
    }
  });

  it("consumes OSC 6973 invisibly and records only a valid continuation", async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const state = createSemanticCopyState(terminal);
    try {
      await write(
        terminal,
        `first\r\n│ ${semanticCopyContinuationMarker(2)}continuation`,
      );

      expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe(
        "│ continuation",
      );
      expect(state.continuationForBufferRow("normal", 1)).toEqual({
        leadingColumns: 2,
        separatorSpaces: 2,
      });

      await write(terminal, `\r> ${semanticCopyContinuationMarker(3)}`);
      expect(state.snapshot().normal).toEqual([
        { row: 1, leadingColumns: 2, separatorSpaces: 3 },
      ]);

      await write(terminal, "\r\nvisible\x1b]6973;station-copy;1;not-a-number\x1b\\text");
      expect(terminal.buffer.active.getLine(2)?.translateToString(true)).toBe("visibletext");
      expect(state.continuationForBufferRow("normal", 2)).toBeUndefined();

      const oversizedPayload = `station-copy;1;${"0".repeat(10_000)}`;
      await write(terminal, `\r\n\x1b]6973;${oversizedPayload}\x1b\\still-visible`);
      expect(terminal.buffer.active.getLine(3)?.translateToString(true)).toBe(
        "still-visible",
      );
      expect(state.continuationForBufferRow("normal", 3)).toBeUndefined();
    } finally {
      state.dispose();
      terminal.dispose();
    }
  });

  it("follows normal-buffer scrollback and never survives eviction", async () => {
    const terminal = new Terminal({
      cols: 20,
      rows: 2,
      scrollback: 2,
      allowProposedApi: true,
    });
    const state = createSemanticCopyState(terminal);
    try {
      await write(terminal, `one\r\n${semanticCopyContinuationMarker(0)}two`);
      await write(terminal, "\r\nthree");
      expect(state.snapshot().normal).toEqual([
        { row: 1, leadingColumns: 0, separatorSpaces: 0 },
      ]);

      await write(terminal, "\r\nfour\r\nfive\r\nsix");
      expect(state.snapshot().normal).toEqual([]);
    } finally {
      state.dispose();
      terminal.dispose();
    }
  });

  it("supports alternate-buffer rows and round-trips both buffer snapshots", async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const state = createSemanticCopyState(terminal);
    try {
      await write(terminal, `normal\r\n${semanticCopyContinuationMarker(1)}n`);
      await write(
        terminal,
        `\x1b[?1049halternate\r\n> ${semanticCopyContinuationMarker(0)}a`,
      );
      const snapshot = state.snapshot();
      expect(snapshot).toEqual({
        normal: [{ row: 1, leadingColumns: 0, separatorSpaces: 1 }],
        alternate: [{ row: 2, leadingColumns: 2, separatorSpaces: 0 }],
      });

      state.clear();
      expect(state.snapshot()).toEqual({ normal: [], alternate: [] });
      expect(state.restore(snapshot)).toEqual({ applied: 2, dropped: 0 });
      expect(state.snapshot()).toEqual(snapshot);

      await write(terminal, "\x1b[?1049l");
      expect(state.snapshot()).toEqual({
        normal: [{ row: 1, leadingColumns: 0, separatorSpaces: 1 }],
        alternate: [],
      });
    } finally {
      state.dispose();
      terminal.dispose();
    }
  });

  it("validates restored snapshots and drops rows that no longer map", async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const state = createSemanticCopyState(terminal);
    try {
      expect(
        state.restore({
          normal: [{ row: 99, leadingColumns: 0, separatorSpaces: 0 }],
          alternate: [],
        }),
      ).toEqual({ applied: 0, dropped: 1 });
      expect(state.snapshot()).toEqual({ normal: [], alternate: [] });
      state.restore({
        normal: [{ row: 0, leadingColumns: 0, separatorSpaces: 0 }],
        alternate: [],
      });
      expect(() =>
        state.restore({
          normal: [
            { row: 0, leadingColumns: 0, separatorSpaces: 0 },
            { row: 0, leadingColumns: 1, separatorSpaces: 1 },
          ],
          alternate: [],
        }),
      ).toThrow();
      expect(state.snapshot()).toEqual({ normal: [], alternate: [] });
    } finally {
      state.dispose();
      terminal.dispose();
    }
  });

  it("clears stale metadata on row erase, display erase, repaint, and reset", async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const state = createSemanticCopyState(terminal);
    try {
      await write(terminal, `one\r\n${semanticCopyContinuationMarker(0)}two`);
      await write(terminal, "\r\x1b[2Khard repaint");
      expect(state.snapshot().normal).toEqual([]);

      await write(terminal, `\r${semanticCopyContinuationMarker(0)}soft`);
      await write(terminal, "\x1b[2J");
      expect(state.snapshot().normal).toEqual([]);

      await write(terminal, `${semanticCopyContinuationMarker(0)}soft`);
      await write(terminal, "\x1bc");
      expect(state.snapshot()).toEqual({ normal: [], alternate: [] });
    } finally {
      state.dispose();
      terminal.dispose();
    }
  });

  it("clears only the rows affected by ECH, ED0, ED1, ED3, and DECSTR", async () => {
    const entries = [0, 1, 2].map((row) => ({
      row,
      leadingColumns: 0,
      separatorSpaces: 0,
    }));
    const scenarios = [
      { sequence: "\x1b[2;1H\x1b[X", remaining: [0, 2] },
      { sequence: "\x1b[2;1H\x1b[J", remaining: [0] },
      { sequence: "\x1b[2;1H\x1b[1J", remaining: [2] },
      { sequence: "\x1b[2;1H\x1b[3J", remaining: [] },
      { sequence: "\x1b[99J", remaining: [] },
      { sequence: "\x1b[!p", remaining: [] },
    ];

    for (const scenario of scenarios) {
      const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
      const state = createSemanticCopyState(terminal);
      try {
        state.restore({ normal: entries, alternate: [] });
        await write(terminal, scenario.sequence);
        expect(state.snapshot().normal.map(({ row }) => row)).toEqual(
          scenario.remaining,
        );
      } finally {
        state.dispose();
        terminal.dispose();
      }
    }
  });

  it("moves metadata with xterm line insertion and deletion", async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const state = createSemanticCopyState(terminal);
    try {
      state.restore({
        normal: [{ row: 2, leadingColumns: 0, separatorSpaces: 1 }],
        alternate: [],
      });
      await write(terminal, "\x1b[2;1H\x1b[L");
      expect(state.snapshot().normal[0]?.row).toBe(3);

      await write(terminal, "\x1b[2;1H\x1b[M");
      expect(state.snapshot().normal[0]?.row).toBe(2);
    } finally {
      state.dispose();
      terminal.dispose();
    }
  });

  it("keeps hard boundaries hard while resize reflows native rows", async () => {
    const screen = createStationVtScreen({ size: { cols: 8, rows: 4 } });
    try {
      screen.feed("abcdef\r\nghij");
      await screen.whenIdle();
      screen.resize({ cols: 4, rows: 4 });
      await screen.whenIdle();

      expect(screen.viewRowCopyContinuation(1)).toEqual({ kind: "terminal-soft" });
      expect(screen.viewRowCopyContinuation(2)).toBeUndefined();
    } finally {
      screen.dispose();
    }
  });

  it("keeps application metadata on its row through resize reflow", async () => {
    const screen = createStationVtScreen({ size: { cols: 8, rows: 4 } });
    try {
      screen.feed(`abcdef\r\n${semanticCopyContinuationMarker(1)}second\r\n`);
      await screen.whenIdle();
      screen.resize({ cols: 4, rows: 4 });
      await screen.whenIdle();

      expect(screen.viewRowCopyContinuation(1)).toEqual({
        kind: "application-soft",
        leadingColumns: 0,
        separatorSpaces: 1,
      });
      expect(screen.viewRowCopyContinuation(2)).toEqual({ kind: "terminal-soft" });
    } finally {
      screen.dispose();
    }
  });

  it("keeps native xterm wrapping authoritative over an application marker", async () => {
    const screen = createStationVtScreen({ size: { cols: 5, rows: 4 } });
    try {
      screen.feed(`12345${semanticCopyContinuationMarker(4)}x`);
      await screen.whenIdle();

      expect(screen.viewRowCopyContinuation(1)).toEqual({ kind: "terminal-soft" });
    } finally {
      screen.dispose();
    }
  });
});
