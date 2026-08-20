import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "bun:test";
import { createStationVtScreen } from "../../terminal/vt/screen.js";
import { resolveXtermCellHyperlink } from "../../terminal/vt/xtermHyperlinks.js";
import {
  SemanticTerminalSnapshot,
  terminalSnapshotFailure,
  TerminalSnapshotPendingError,
  TerminalSnapshotUnavailableError,
} from "../semanticTerminalSnapshot.js";
import {
  type PinnedXtermAttributes,
  unsupportedXtermCellAttributeDetail,
} from "../xtermSnapshotAttributes.js";

const CSI = "\x1b[";
const CURSOR_UNDERLINED_LINK =
  "\x1b]8;;https://example.invalid\x07" + `${CSI}4mX${CSI}24m` + "\x1b]8;;\x07";

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

function target(cols: number, rows: number): Terminal {
  const terminal = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon() as never);
  terminal.unicode.activeVersion = "11";
  return terminal;
}

function lines(terminal: Terminal, buffer = terminal.buffer.active): string[] {
  return Array.from({ length: buffer.length }, (_, row) =>
    buffer.getLine(row)?.translateToString(true) ?? "",
  );
}

function visibleLines(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) =>
    buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "",
  );
}

function margins(terminal: Terminal): [number, number] {
  const pinned = terminal as unknown as {
    _core: { _bufferService: { buffer: { scrollBottom: number; scrollTop: number } } };
  };
  return [
    pinned._core._bufferService.buffer.scrollTop,
    pinned._core._bufferService.buffer.scrollBottom,
  ];
}

function unsupportedAttributes(options: {
  protected?: boolean;
  storedUnderlineStyle?: number;
  underlineColor?: number;
  underlineOffset?: number;
  underlineStyle?: number;
  urlId?: number;
}): PinnedXtermAttributes {
  const extended = {
    underlineColor: options.underlineColor ?? 0,
    underlineStyle: options.storedUnderlineStyle ?? options.underlineStyle ?? 1,
    urlId: options.urlId ?? 0,
    clone() {
      return { ...this };
    },
  };
  return {
    extended,
    getUnderlineStyle: () => options.underlineStyle ?? 1,
    getUnderlineVariantOffset: () => options.underlineOffset ?? 0,
    isProtected: () => (options.protected === true ? 1 : 0),
  } as PinnedXtermAttributes;
}

async function captureError(source: SemanticTerminalSnapshot): Promise<Error> {
  try {
    await source.capture();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected semantic capture to fail.");
}

describe("SemanticTerminalSnapshot", () => {
  it("classifies rejected cell attributes without inspecting terminal content", () => {
    expect(unsupportedXtermCellAttributeDetail(unsupportedAttributes({ protected: true }))).toBe(
      "cell-protected",
    );
    expect(unsupportedXtermCellAttributeDetail(unsupportedAttributes({ underlineStyle: 3 }))).toBe(
      "cell-underline-style",
    );
    expect(unsupportedXtermCellAttributeDetail(unsupportedAttributes({ underlineColor: 1 }))).toBe(
      "cell-underline-color",
    );
    expect(unsupportedXtermCellAttributeDetail(unsupportedAttributes({ underlineOffset: 1 }))).toBe(
      "cell-underline-offset",
    );
    expect(
      unsupportedXtermCellAttributeDetail(
        unsupportedAttributes({ underlineStyle: 5, storedUnderlineStyle: 1, urlId: 1 }),
      ),
    ).toBeUndefined();
    expect(
      unsupportedXtermCellAttributeDetail(
        unsupportedAttributes({ underlineStyle: 5, storedUnderlineStyle: 3, urlId: 1 }),
      ),
    ).toBe("cell-underline-style");
  });

  it("round-trips retained history, cursor, styling, and title", async () => {
    const source = new SemanticTerminalSnapshot(12, 4);
    const restored = target(12, 4);
    let title = "";
    const titleSubscription = restored.onTitleChange((value) => {
      title = value;
    });
    try {
      source.write("one\r\ntwo\r\nthree\r\nfour\r\nfive\x1b[31;1m red\x1b]2;agent\x07");
      const [snapshot] = await source.capture();
      await write(restored, `dirty${CSI}?1049hother${CSI}?1049l${snapshot}`);

      expect(lines(restored)).toEqual(["one", "two", "three", "four", "five red"]);
      expect(restored.buffer.active.cursorX).toBe(8);
      expect(restored.buffer.active.cursorY).toBe(3);
      const finalCell = restored.buffer.active.getLine(4)?.getCell(7);
      expect(finalCell?.getFgColor()).toBe(1);
      expect(Boolean(finalCell?.isBold())).toBe(true);
      expect(title).toBe("agent");
    } finally {
      titleSubscription.dispose();
      source.dispose();
      restored.dispose();
    }
  });

  it("round-trips an active alternate screen and its hidden normal history", async () => {
    const source = new SemanticTerminalSnapshot(14, 4);
    const restored = target(14, 4);
    try {
      source.write("n1\r\nn2\r\nn3\r\nn4\r\nn5");
      source.write(`${CSI}?1049h${CSI}Halternate`);
      const [snapshot] = await source.capture();
      await write(restored, snapshot);

      expect(restored.buffer.active.type).toBe("alternate");
      expect(lines(restored, restored.buffer.alternate)).toContain("alternate");
      await write(restored, `${CSI}?1049l`);
      expect(lines(restored, restored.buffer.normal)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  it("preserves resize reflow and Unicode 11 cell widths", async () => {
    const source = new SemanticTerminalSnapshot(8, 3);
    const restored = target(5, 6);
    try {
      source.write("alpha界bravo\r\ncharlie");
      source.resize(5, 6);
      const [snapshot] = await source.capture();
      restored.resize(5, 6);
      await write(restored, snapshot);

      expect(lines(restored).join("")).toContain("alpha界bravo");
      const wideCell = restored.buffer.active.getLine(1)?.getCell(0);
      expect(wideCell?.getChars()).toBe("界");
      expect(wideCell?.getWidth()).toBe(2);
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  it("retains semantic history after the raw replay budget would be exceeded", async () => {
    const source = new SemanticTerminalSnapshot(100, 20);
    const restored = target(100, 20);
    try {
      const output = Array.from(
        { length: 4_000 },
        (_, index) => `${String(index).padStart(4, "0")}:${"x".repeat(75)}\r\n`,
      ).join("");
      expect(Buffer.byteLength(output, "utf8")).toBeGreaterThan(256 * 1024);
      source.write(output);
      const [snapshot] = await source.capture();
      await write(restored, snapshot);

      const restoredText = lines(restored).join("\n");
      expect(restoredText).toContain("0000:");
      expect(restoredText).toContain("3999:");
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  it("matches Station's synchronized-frame scrollback policy", async () => {
    const source = new SemanticTerminalSnapshot(12, 5);
    const restored = target(12, 5);
    try {
      source.write(`one\r\ntwo${CSI}?2026h${CSI}2J${CSI}Hframe`);
      const [snapshot] = await source.capture();
      await write(restored, snapshot);

      expect(lines(restored)).toEqual(["one", "two", "frame", "", "", "", ""]);
      expect(restored.buffer.normal.baseY).toBe(2);
      expect(restored.modes.synchronizedOutputMode).toBe(true);
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  it("restores the cursor after addon-serialize enables origin mode", async () => {
    const originSource = new SemanticTerminalSnapshot(12, 5);
    const originTarget = target(12, 5);
    try {
      originSource.write(`${CSI}?6h${CSI}3;4H`);
      const [originSnapshot] = await originSource.capture();
      await write(originTarget, originSnapshot);
      expect(originTarget.modes.originMode).toBe(true);
      expect([originTarget.buffer.active.cursorX, originTarget.buffer.active.cursorY]).toEqual([
        3, 2,
      ]);
    } finally {
      originSource.dispose();
      originTarget.dispose();
    }
  });

  it("restores hidden normal-buffer margins and kitty state", async () => {
    const source = new SemanticTerminalSnapshot(12, 5);
    const restored = target(12, 5);
    const responses: string[] = [];
    const screen = createStationVtScreen({
      size: { cols: 12, rows: 5 },
      onResponse: (data) => responses.push(data),
    });
    try {
      source.write(
        `${CSI}2;4r${CSI}3;4H${CSI}=1u` + `${CSI}?1049h${CSI}=2uALT`,
      );
      const [snapshot] = await source.capture();
      await write(restored, `${snapshot}${CSI}?1049lX`);

      const normal = restored.buffer.normal;
      expect(normal.getLine(2)?.getCell(3)?.getChars()).toBe("X");
      const pinned = restored as unknown as {
        _core: { _bufferService: { buffer: { scrollBottom: number; scrollTop: number } } };
      };
      expect([
        pinned._core._bufferService.buffer.scrollTop,
        pinned._core._bufferService.buffer.scrollBottom,
      ]).toEqual([1, 3]);

      screen.feed(`${snapshot}${CSI}?u${CSI}?1049l${CSI}?u`);
      await screen.whenIdle();
      expect(responses).toEqual([`${CSI}?2u`, `${CSI}?1u`]);
    } finally {
      source.dispose();
      restored.dispose();
      screen.dispose();
    }
  });

  it("restores mixed blank backgrounds omitted by addon-serialize", async () => {
    const source = new SemanticTerminalSnapshot(12, 5);
    const restored = target(12, 5);
    try {
      source.write(`${CSI}44m${CSI}2J${CSI}3;1H${CSI}49m${CSI}12X${CSI}31;1m`);
      const [snapshot] = await source.capture();
      await write(restored, `${snapshot}X`);

      expect(
        Array.from(
          { length: 5 },
          (_, row) => restored.buffer.active.getLine(row)?.getCell(0)?.getBgColor(),
        ),
      ).toEqual([4, 4, -1, 4, 4]);
      const written = restored.buffer.active.getLine(2)?.getCell(0);
      expect(written?.getFgColor()).toBe(1);
      expect(Boolean(written?.isBold())).toBe(true);
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  it("does not erase a wide glyph while repairing adjacent blank backgrounds", async () => {
    const source = new SemanticTerminalSnapshot(12, 5);
    const restored = target(12, 5);
    try {
      source.write(`${CSI}31;44m界${CSI}0m`);
      const [snapshot] = await source.capture();
      await write(restored, snapshot);

      const line = restored.buffer.active.getLine(0);
      expect(line?.getCell(0)?.getChars()).toBe("界");
      expect(line?.getCell(0)?.getWidth()).toBe(2);
      expect(line?.getCell(0)?.getFgColor()).toBe(1);
      expect(line?.getCell(0)?.getBgColor()).toBe(4);
      expect(line?.getCell(1)?.getWidth()).toBe(0);
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  it("preserves a naturally wrapped wide glyph", async () => {
    const source = new SemanticTerminalSnapshot(12, 5);
    const restored = target(12, 5);
    try {
      source.write("abcdefghijk界");
      const [snapshot] = await source.capture();
      await write(restored, snapshot);

      const wrapped = restored.buffer.active.getLine(1);
      expect(wrapped?.isWrapped).toBe(true);
      expect(wrapped?.getCell(0)?.getChars()).toBe("界");
      expect(wrapped?.getCell(0)?.getWidth()).toBe(2);
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  const wrapPendingCases = [
    {
      name: "a normal-buffer one-cell grapheme with default blanks",
      input: `${CSI}2;5r${CSI}3;1Habcdefghijkl`,
      activeType: "normal",
      originMode: false,
      text: "abcdefghijkl",
      trailingColumn: 11,
      trailing: { chars: "l", width: 1, foreground: -1, background: -1, bold: false },
      current: { foreground: -1, background: -1, bold: false },
      blankBackground: -1,
    },
    {
      name: "an OpenCode-like incomplete alternate frame with default blanks",
      input: `${CSI}?1049h${CSI}2;5r${CSI}3;1Habcdefghijkl`,
      activeType: "alternate",
      originMode: false,
      text: "abcdefghijkl",
      trailingColumn: 11,
      trailing: { chars: "l", width: 1, foreground: -1, background: -1, bold: false },
      current: { foreground: -1, background: -1, bold: false },
      blankBackground: -1,
    },
    {
      name: "non-default blank backgrounds requiring BCE repair",
      input:
        `${CSI}44m${CSI}2J${CSI}2;5r${CSI}3;1H` +
        `${CSI}31;43;1mabcdefghijkl${CSI}0;32;45m`,
      activeType: "normal",
      originMode: false,
      text: "abcdefghijkl",
      trailingColumn: 11,
      trailing: { chars: "l", width: 1, foreground: 1, background: 3, bold: true },
      current: { foreground: 2, background: 5, bold: false },
      blankBackground: 4,
    },
    {
      name: "a two-cell trailing grapheme whose attributes differ from input",
      input:
        `${CSI}2;5r${CSI}3;1H` +
        `${CSI}31;43;1mabcdefghij界${CSI}0;32;45m`,
      activeType: "normal",
      originMode: false,
      text: "abcdefghij界",
      trailingColumn: 10,
      trailing: { chars: "界", width: 2, foreground: 1, background: 3, bold: true },
      current: { foreground: 2, background: 5, bold: false },
      blankBackground: -1,
    },
    {
      name: "custom margins with origin mode",
      input:
        `${CSI}2;5r${CSI}?6h${CSI}2;1H` +
        `${CSI}36;43mabcdefghijkl${CSI}0;35m`,
      activeType: "normal",
      originMode: true,
      text: "abcdefghijkl",
      trailingColumn: 11,
      trailing: { chars: "l", width: 1, foreground: 6, background: 3, bold: false },
      current: { foreground: 5, background: -1, bold: false },
      blankBackground: -1,
    },
    {
      name: "saved-cursor restoration",
      input:
        `${CSI}2;3H${CSI}31m\x1b7${CSI}2;5r${CSI}3;1H` +
        `${CSI}34mabcdefghijkl${CSI}0;32m`,
      activeType: "normal",
      originMode: false,
      text: "abcdefghijkl",
      trailingColumn: 11,
      trailing: { chars: "l", width: 1, foreground: 4, background: -1, bold: false },
      current: { foreground: 2, background: -1, bold: false },
      blankBackground: -1,
      saved: { row: 1, column: 2, foreground: 1 },
    },
  ] as const;

  for (const testCase of wrapPendingCases) {
    it(`restores wrap-pending state after ${testCase.name}`, async () => {
      const source = new SemanticTerminalSnapshot(12, 6);
      const restored = target(12, 6);
      try {
        source.write(testCase.input);
        const [snapshot] = await source.capture();
        await write(restored, snapshot);

        const expectedLines = ["", "", testCase.text, "", "", ""];
        expect(visibleLines(restored)).toEqual(expectedLines);
        expect(restored.buffer.active.type).toBe(testCase.activeType);
        expect(margins(restored)).toEqual([1, 4]);
        expect(restored.modes.originMode).toBe(testCase.originMode);
        expect([restored.buffer.active.cursorX, restored.buffer.active.cursorY]).toEqual([12, 2]);

        const line = restored.buffer.active.getLine(
          restored.buffer.active.baseY + restored.buffer.active.cursorY,
        );
        const trailing = line?.getCell(testCase.trailingColumn);
        expect({
          chars: trailing?.getChars(),
          width: trailing?.getWidth(),
          foreground: trailing?.getFgColor(),
          background: trailing?.getBgColor(),
          bold: Boolean(trailing?.isBold()),
        }).toEqual(testCase.trailing);
        for (const row of [0, 1, 3, 4, 5]) {
          const blankLine = restored.buffer.active.getLine(restored.buffer.active.baseY + row);
          expect(
            Array.from(
              { length: restored.cols },
              (_, column) => blankLine?.getCell(column)?.getBgColor(),
            ),
          ).toEqual(Array.from({ length: restored.cols }, () => testCase.blankBackground));
        }

        await write(restored, "Z");
        expect([restored.buffer.active.cursorX, restored.buffer.active.cursorY]).toEqual([1, 3]);
        const written = restored.buffer.active.getLine(restored.buffer.active.baseY + 3)?.getCell(0);
        expect({
          foreground: written?.getFgColor(),
          background: written?.getBgColor(),
          bold: Boolean(written?.isBold()),
        }).toEqual(testCase.current);

        if ("saved" in testCase) {
          await write(restored, "\x1b8S");
          const saved = restored.buffer.active
            .getLine(restored.buffer.active.baseY + testCase.saved.row)
            ?.getCell(testCase.saved.column);
          expect(saved?.getChars()).toBe("S");
          expect(saved?.getFgColor()).toBe(testCase.saved.foreground);
        }
      } finally {
        source.dispose();
        restored.dispose();
      }
    });
  }

  it("restores Station cursor and mouse semantics after reset", async () => {
    const source = new SemanticTerminalSnapshot(12, 5);
    const screen = createStationVtScreen({ size: { cols: 12, rows: 5 } });
    try {
      source.write(`${CSI}?25l\x1bc${CSI}?1002h${CSI}?1006h${CSI}?1016h`);
      const [snapshot] = await source.capture();
      screen.feed(snapshot);
      await screen.whenIdle();

      expect(screen.isCursorVisible()).toBe(true);
      expect(screen.mouseProtocol()).toEqual({ tracking: "drag", encoding: "sgr" });
    } finally {
      source.dispose();
      screen.dispose();
    }
  });

  it("restores active saved cursors without rejecting completed alternate-screen use", async () => {
    const normalSource = new SemanticTerminalSnapshot(12, 5);
    const normalTarget = target(12, 5);
    const alternateSource = new SemanticTerminalSnapshot(12, 5);
    const alternateTarget = target(12, 5);
    try {
      normalSource.write(
        `${CSI}31m${CSI}3;4H${CSI}?1049h${CSI}34m${CSI}2;3H\x1b7ALT` +
          `${CSI}?1049l${CSI}32m${CSI}Hshell`,
      );
      const [normalSnapshot] = await normalSource.capture();
      await write(normalTarget, `${normalSnapshot}\x1b8X`);
      expect([normalTarget.buffer.active.cursorX, normalTarget.buffer.active.cursorY]).toEqual([
        4, 2,
      ]);
      expect(normalTarget.buffer.active.getLine(2)?.getCell(3)?.getFgColor()).toBe(1);
      await write(normalTarget, `${CSI}?47h\x1b8Y`);
      expect(normalTarget.buffer.active.getLine(1)?.getCell(2)?.getFgColor()).toBe(4);

      alternateSource.write(`${CSI}3;4H${CSI}?1049h${CSI}2;3H${CSI}1;2s${CSI}H`);
      const [alternateSnapshot] = await alternateSource.capture();
      await write(alternateTarget, `${alternateSnapshot}\x1b8`);
      expect([alternateTarget.buffer.active.cursorX, alternateTarget.buffer.active.cursorY]).toEqual([
        2, 1,
      ]);
      await write(alternateTarget, `${CSI}?1049l`);
      expect([alternateTarget.buffer.active.cursorX, alternateTarget.buffer.active.cursorY]).toEqual([
        3, 2,
      ]);
    } finally {
      normalSource.dispose();
      normalTarget.dispose();
      alternateSource.dispose();
      alternateTarget.dispose();
    }
  });

  it("restores closed OSC 8 text while dropping unserializable link metadata", async () => {
    const source = new SemanticTerminalSnapshot(20, 4);
    const restored = target(20, 4);
    try {
      source.write("\x1b]8;;https://example.com\x1b\\linked\x1b]8;;\x1b\\ text");
      const [snapshot] = await source.capture();
      await write(restored, snapshot);

      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("linked text");
      const linkedCell = restored.buffer.active.getLine(0)?.getCell(0);
      if (linkedCell === undefined) throw new Error("Restored link cell is unavailable.");
      expect(resolveXtermCellHyperlink(restored, linkedCell)).toBeUndefined();
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  it("preserves history and ordinary underline from Cursor-style OSC 8 cells", async () => {
    const source = new SemanticTerminalSnapshot(20, 4);
    const restored = target(20, 4);
    try {
      source.write(`one\r\ntwo\r\nthree\r\nfour\r\n${CURSOR_UNDERLINED_LINK}`);
      const [snapshot] = await source.capture();
      await write(restored, snapshot);

      expect(lines(restored)).toEqual(["one", "two", "three", "four", "X"]);
      const linkedCell = restored.buffer.active.getLine(4)?.getCell(0);
      expect(Boolean(linkedCell?.isUnderline())).toBe(true);
      if (linkedCell === undefined) throw new Error("Restored underlined cell is unavailable.");
      expect(resolveXtermCellHyperlink(restored, linkedCell)).toBeUndefined();
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  it("rejects terminal state the serializer cannot represent exactly", async () => {
    const cases = [
      ["character-set", "Cannot restore non-default terminal character sets.", "\x1b(0"],
      ["custom-tabs", "Cannot restore custom normal tab stops.", `${CSI}3g${CSI}5G\x88`],
      [
        "cell-protected",
        "Cannot restore unsupported normal attributes at row 1, column 1.",
        `${CSI}1"qX${CSI}0"q`,
      ],
      [
        "cell-underline-style",
        "Cannot restore unsupported normal attributes at row 1, column 1.",
        `${CSI}4:3mX${CSI}0m`,
      ],
      [
        "cell-underline-style",
        "Cannot restore unsupported normal attributes at row 1, column 1.",
        "\x1b]8;;https://example.invalid\x07" +
          `${CSI}4:3mX${CSI}0m` +
          "\x1b]8;;\x07",
      ],
      [
        "cell-underline-color",
        "Cannot restore unsupported normal attributes at row 1, column 1.",
        `${CSI}4;58:2::255:0:0mX${CSI}0m`,
      ],
      [
        "current-attributes",
        "Cannot restore unsupported current terminal attributes.",
        "\x1b]8;;https://example.com\x1b\\open",
      ],
      [
        "alternate-mode",
        "Cannot restore an alternate buffer entered without DECSET 1049.",
        `${CSI}?47h`,
      ],
      [
        "nonserializable-wrap",
        "Cannot restore a non-serializable wrapped normal line at row 2.",
        `abcdefghijklX${CSI}1D${CSI}1X`,
      ],
      [
        "nonserializable-wrap",
        "Cannot restore a non-serializable wrapped normal line at row 2.",
        `${CSI}1;12H界`,
      ],
      [
        "hidden-attributes",
        "Cannot restore non-default hidden normal-buffer attributes.",
        `${CSI}31m${CSI}?1049h`,
      ],
      [
        "saved-cursor",
        "Cannot restore a saved normal cursor.",
        `\x1b7${CSI}?47h`,
      ],
      [
        "saved-attributes",
        "Cannot restore unsupported saved normal attributes.",
        `${CSI}1"q\x1b7${CSI}0"q`,
      ],
      [
        "wrap-pending-cell",
        "Cannot restore the normal wrap-pending trailing cell.",
        `abcdefghijkl${CSI}2K`,
      ],
    ] as const;

    for (const [detail, message, input] of cases) {
      const source = new SemanticTerminalSnapshot(12, 5);
      try {
        source.write(input);
        const error = await captureError(source);
        expect(error instanceof TerminalSnapshotUnavailableError).toBe(true);
        expect(error).toMatchObject({
          message,
          reason: "unsupported-state",
          diagnostic: { reason: "unsupported-state", detail },
        });
        expect((error as TerminalSnapshotUnavailableError).resetData.startsWith("\x1bc")).toBe(
          true,
        );
      } finally {
        source.dispose();
      }
    }
  });

  it("carries boundary-captured reset data when xterm serialization fails", async () => {
    const serializer = new SerializeAddon();
    serializer.serialize = () => {
      throw new Error("serializer failed");
    };
    const source = new SemanticTerminalSnapshot(20, 4, serializer);
    try {
      source.write(`${CSI}?2004h`);
      const failure = source.capture();
      source.write(`${CSI}?2004l`);

      const error = await failure.catch((cause: unknown) => cause);
      expect(error instanceof TerminalSnapshotUnavailableError).toBe(true);
      expect(error).toMatchObject({
        reason: "serialization-failed",
        message: "Could not serialize the semantic terminal model.",
      });
      expect((error as TerminalSnapshotUnavailableError).resetData).toContain(`${CSI}?2004h`);
    } finally {
      source.dispose();
    }
  });

  it("carries reset data when an asynchronous model update poisons capture", async () => {
    const source = new SemanticTerminalSnapshot(20, 4);
    try {
      source.write(`${CSI}?1h`);
      source.resize(1.5, 2.5);

      const error = await captureError(source);
      expect(error instanceof TerminalSnapshotUnavailableError).toBe(true);
      expect(error).toMatchObject({
        reason: "model-update-failed",
        message: "Could not update the semantic terminal model.",
      });
      expect((error as TerminalSnapshotUnavailableError).resetData).toContain(`${CSI}?1h`);
      expect(terminalSnapshotFailure(error)).toEqual({ reason: "model-update-failed" });
    } finally {
      source.dispose();
    }
  });

  it("rejects unfinished parser families instead of replaying guessed prefixes", async () => {
    const unfinished = [
      "\x1b",
      `${CSI}31`,
      "\x1b]2;title",
      "\x1bP$qpayload",
      "\x1b_payload",
      "\x9b31",
      "\x9d2;title",
    ];

    for (const input of unfinished) {
      const source = new SemanticTerminalSnapshot(12, 5);
      try {
        source.write(input);
        await expect(source.capture()).rejects.toMatchObject({
          message: "Cannot capture terminal state in the middle of an input sequence.",
        });
      } finally {
        source.dispose();
      }
    }
  });

  it("fails closed between parser boundaries and succeeds after the sequence completes", async () => {
    const source = new SemanticTerminalSnapshot(20, 4);
    const restored = target(20, 4);
    try {
      source.write(`${CSI}31`);
      const pending = await captureError(source);
      expect(pending instanceof TerminalSnapshotPendingError).toBe(true);
      expect(pending).toMatchObject({
        message: "Cannot capture terminal state in the middle of an input sequence.",
      });
      expect((pending as TerminalSnapshotPendingError & { resetData?: string }).resetData).toBeUndefined();

      source.write("mred");
      const [snapshot] = await source.capture();
      await write(restored, snapshot);
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("red");
      expect(restored.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(1);
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  it("normalizes unknown serializer failures without unsafe detail", () => {
    expect(terminalSnapshotFailure(new Error("unsafe serializer context"))).toEqual({
      reason: "serialization-failed",
    });
  });

  it("fails closed while xterm retains an unfinished UTF-16 surrogate", async () => {
    const source = new SemanticTerminalSnapshot(20, 4);
    const restored = target(20, 4);
    try {
      source.write("emoji-\ud83d");
      await expect(source.capture()).rejects.toMatchObject({
        message: "Cannot capture terminal state in the middle of an input sequence.",
      });

      source.write("\ude42");
      const [snapshot] = await source.capture();
      await write(restored, snapshot);
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("emoji-🙂");
    } finally {
      source.dispose();
      restored.dispose();
    }
  });
});
