import { SerializeAddon } from "@xterm/addon-serialize";
import { type IBuffer, Terminal } from "@xterm/headless";
import { describe, expect, it } from "bun:test";
import { TerminalRestoreState } from "./terminalRestoreState.js";

const CSI = "\x1b[";
const RIS = "\x1bc";

type Model = {
  terminal: Terminal;
  serializer: SerializeAddon;
  restore: TerminalRestoreState;
};

function createModel(cols = 20, rows = 6, scrollback = 100): Model {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
    logLevel: "off",
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer as never);
  return { terminal, serializer, restore: new TerminalRestoreState(terminal, serializer) };
}

async function feed(model: Model, data: string): Promise<void> {
  await model.restore.write(data);
}

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

async function restore(source: Model, target: Model): Promise<void> {
  await write(
    target.terminal,
    RIS + source.restore.restoreSerialization(source.serializer.serialize()),
  );
}

function lines(buffer: IBuffer): string[] {
  return Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
  );
}

async function modeReport(terminal: Terminal, mode: number, privateMode = true): Promise<string> {
  const replies: string[] = [];
  const subscription = terminal.onData((data) => replies.push(data));
  try {
    await write(terminal, `${CSI}${privateMode ? "?" : ""}${mode}$p`);
    return replies.join("");
  } finally {
    subscription.dispose();
  }
}

function dispose(model: Model): void {
  model.restore.dispose();
  model.terminal.dispose();
}

describe("TerminalRestoreState", () => {
  it("emits only modes omitted by official serialization", async () => {
    const model = createModel();
    try {
      await feed(
        model,
        `${CSI}?1h${CSI}?1002h${CSI}?2004h${CSI}?25l${CSI}?1006h${CSI}>5u${CSI}?2026h`,
      );
      const restore = model.restore.restoreSequence();
      expect(restore).not.toContain(`${CSI}?1h`);
      expect(restore).not.toContain(`${CSI}?1002h`);
      expect(restore).not.toContain(`${CSI}?2004h`);
      expect(restore).toContain(`${CSI}?25l`);
      expect(restore).toContain(`${CSI}?1006h`);
      expect(restore).toContain(`${CSI}>5u`);
      expect(restore.endsWith(`${CSI}?2026h`)).toBe(true);
    } finally {
      dispose(model);
    }
  });

  it("tracks missing mode sequences across arbitrary chunk boundaries", async () => {
    const model = createModel();
    try {
      await feed(model, `plain${CSI}?10`);
      await feed(model, `06h${CSI}>`);
      await feed(model, "3u");
      const restoration = model.restore.restoreSequence();
      expect(restoration).toContain(`${CSI}>3u`);
      expect(restoration).toContain(`${CSI}?1006h`);
      expect(restoration.endsWith(`${CSI}?12l${CSI}20l${CSI}?25h`)).toBe(true);
    } finally {
      dispose(model);
    }
  });

  it("keeps charset controls inside OSC inert and honors ESC transitions out of strings", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(source, `\x1b)0\x0e\x1b]2;ignored\x0e${RIS}`);
      await restore(source, target);
      await feed(source, "q");
      await write(target.terminal, "q");
      expect(target.terminal.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe("q");
      expect(target.serializer.serialize()).toBe(source.serializer.serialize());
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("honors C1 transitions out of strings", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(source, `\x1b)0\x0e\x1b]2;ignored\x9b?2h`);
      await restore(source, target);
      await feed(source, "q");
      await write(target.terminal, "q");
      expect(target.terminal.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe("q");
      expect(target.serializer.serialize()).toBe(source.serializer.serialize());
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("ignores CSI identifiers that xterm does not dispatch to tracked handlers", async () => {
    for (const [setup, suffix] of [
      [`\x1b(0${CSI}?1!p`, "q"],
      [
        `${CSI}?1049;47!h\x1b(0${CSI}3;4H\x1b7\x1b(B${CSI}6;10H`,
        "\x1b8q",
      ],
    ]) {
      const source = createModel(20, 8);
      const target = createModel(20, 8);
      try {
        await feed(source, setup);
        await restore(source, target);

        await feed(source, suffix);
        await write(target.terminal, suffix);
        expect(target.serializer.serialize()).toBe(source.serializer.serialize());
      } finally {
        dispose(source);
        dispose(target);
      }
    }
  });

  it("follows xterm error recovery for non-ASCII ESC payloads", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(source, "\x1bé(0");
      await restore(source, target);

      await feed(source, "q");
      await write(target.terminal, "q");
      expect(target.serializer.serialize()).toBe(source.serializer.serialize());
      expect(target.terminal.buffer.active.getLine(0)?.getCell(2)?.getChars()).toBe("q");
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("clears supplemental modes on RIS", async () => {
    const model = createModel();
    try {
      await feed(model, `${CSI}?25l${CSI}>3u\x1bc`);
      expect(
        model.restore.restoreSequence().endsWith(`${CSI}?12l${CSI}20l${CSI}?25h`),
      ).toBe(true);
    } finally {
      dispose(model);
    }
  });

  it("applies modes after RIS in stream order", async () => {
    const model = createModel();
    try {
      await feed(model, `${CSI}?25l${CSI}?1006h${RIS}${CSI}?25l`);
      expect(
        model.restore.restoreSequence().endsWith(`${CSI}?12l${CSI}20l${CSI}?25l`),
      ).toBe(true);
    } finally {
      dispose(model);
    }
  });

  it("models DECSTR as a selective reset", async () => {
    const source = createModel(20, 8);
    const target = createModel(20, 8);
    try {
      await feed(
        source,
        `${CSI}?25l${CSI}?1006h${CSI}?2026h${CSI}2;6r` +
          `${CSI}31;1m${CSI}4;7H\x1b7${CSI}!p`,
      );

      const supplemental = source.restore.restoreSequence();
      expect(supplemental).toContain(`${CSI}?1006h`);
      expect(supplemental).not.toContain(`${CSI}?25l`);
      expect(supplemental).not.toContain(`${CSI}?2026h`);
      expect(supplemental).not.toContain(`${CSI}2;6r`);

      await restore(source, target);
      expect(await modeReport(target.terminal, 25)).toContain(`${CSI}?25;1$y`);
      expect(await modeReport(target.terminal, 1006)).toContain(`${CSI}?1006;1$y`);
      expect(target.terminal.modes.synchronizedOutputMode).toBe(false);

      await feed(source, "\x1b8X");
      await write(target.terminal, "\x1b8X");
      expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
      expect(target.terminal.buffer.active.cursorY).toBe(source.terminal.buffer.active.cursorY);
      const restored = target.terminal.buffer.active.getLine(0)?.getCell(0);
      expect(restored?.getChars()).toBe("X");
      expect(restored?.isAttributeDefault()).toBe(true);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores the default DECSC slot established by DECSTR after scrollback", async () => {
    const source = createModel(12, 5);
    const target = createModel(12, 5);
    try {
      await feed(source, `${CSI}5H\n${CSI}!p`);
      await restore(source, target);
      source.terminal.resize(12, 8);
      target.terminal.resize(12, 8);

      await feed(source, "\x1b8X");
      await write(target.terminal, "\x1b8X");
      expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
      expect(target.terminal.buffer.active.cursorY).toBe(source.terminal.buffer.active.cursorY);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores scroll margins without losing the final cursor", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(source, `${CSI}2;5r${CSI}4;7Hcursor`);
      const before = source.terminal.buffer.active;
      await new Promise<void>((resolve) =>
        target.terminal.write(
          `\x1bc${source.serializer.serialize()}${source.restore.restoreSequence()}`,
          resolve,
        ),
      );
      expect(target.terminal.buffer.active.cursorX).toBe(before.cursorX);
      expect(target.terminal.buffer.active.cursorY).toBe(before.cursorY);

      await feed(source, `${CSI}5;1H\n`);
      await new Promise<void>((resolve) => target.terminal.write(`${CSI}5;1H\n`, resolve));
      expect(target.serializer.serialize()).toBe(source.serializer.serialize());
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores the final cursor after origin mode homes the replay target", async () => {
    const source = createModel(12, 5);
    const target = createModel(12, 5);
    try {
      await feed(source, `${CSI}?6h\t`);
      await restore(source, target);
      expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
      expect(target.terminal.buffer.active.cursorY).toBe(source.terminal.buffer.active.cursorY);

      await feed(source, "X");
      await write(target.terminal, "X");
      expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores a saved cursor outside active origin margins", async () => {
    const source = createModel(12, 5);
    const target = createModel(12, 5);
    try {
      await feed(source, `${CSI}2;4r\x1b7${CSI}?6h`);
      await restore(source, target);

      const suffix = `${CSI}?6l\x1b8X`;
      await feed(source, suffix);
      await write(target.terminal, suffix);
      expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("fails closed for an active cursor outside its origin-mode margins", async () => {
    const source = createModel(12, 5);
    try {
      await feed(source, `${CSI}2;4r${CSI}?47h${CSI}?6h${CSI}?1047l`);
      expect(() => source.restore.restoreSerialization(source.serializer.serialize())).toThrow(
        /cursor outside its origin-mode scroll region/u,
      );
    } finally {
      dispose(source);
    }
  });

  it("uses only primary CSI parameters when restoring scroll margins", async () => {
    const source = createModel(12, 6);
    const target = createModel(12, 6);
    try {
      await feed(source, `${CSI}2:9;5r${CSI}H1\r\n2\r\n3\r\n4\r\n5\r\n6`);
      await restore(source, target);

      const suffix = `${CSI}5;1H\n`;
      await feed(source, suffix);
      await write(target.terminal, suffix);
      expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores a wrap-pending cursor with default and non-default modes", async () => {
    for (const setup of ["abcde", `${CSI}4h${CSI}31mabcde`]) {
      const source = createModel(5, 4);
      const target = createModel(5, 4);
      try {
        await feed(source, setup);
        expect(source.terminal.buffer.active.cursorX).toBe(5);
        await restore(source, target);
        expect(target.terminal.buffer.active.cursorX).toBe(5);
        expect(target.terminal.modes.insertMode).toBe(source.terminal.modes.insertMode);

        await feed(source, "X");
        await write(target.terminal, "X");
        expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
        expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
        expect(target.terminal.buffer.active.cursorY).toBe(source.terminal.buffer.active.cursorY);
      } finally {
        dispose(source);
        dispose(target);
      }
    }
  });

  it("restores DECSC position and SGR while retaining the current cursor", async () => {
    const source = createModel(20, 8);
    const target = createModel(20, 8);
    try {
      await feed(source, `${CSI}31;1m${CSI}3;4H\x1b7${CSI}32;22m${CSI}6;10H`);
      await new Promise<void>((resolve) =>
        target.terminal.write(
          `\x1bc${source.serializer.serialize()}${source.restore.restoreSequence()}`,
          resolve,
        ),
      );
      const current = source.terminal.buffer.active;
      expect(target.terminal.buffer.active.cursorX).toBe(current.cursorX);
      expect(target.terminal.buffer.active.cursorY).toBe(current.cursorY);

      await new Promise<void>((resolve) => target.terminal.write("C\x1b8S", resolve));
      const currentCell = target.terminal.buffer.active.getLine(5)?.getCell(9);
      const savedCell = target.terminal.buffer.active.getLine(2)?.getCell(3);
      expect(currentCell?.getFgColor()).toBe(2);
      expect(Boolean(currentCell?.isBold())).toBe(false);
      expect(savedCell?.getFgColor()).toBe(1);
      expect(Boolean(savedCell?.isBold())).toBe(true);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores a saved wrap-pending cursor", async () => {
    const source = createModel(12, 5);
    const target = createModel(12, 5);
    try {
      await feed(source, `${CSI}4;12Ha\x1b7`);
      await restore(source, target);
      source.terminal.resize(20, 5);
      target.terminal.resize(20, 5);

      await feed(source, "\x1b8X");
      await write(target.terminal, "\x1b8X");
      expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
      expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("fails closed when serializer-omitted attributes could change future output", async () => {
    for (const setup of [
      `${CSI}1\"q`,
      `${CSI}1\"q\x1b7${CSI}0\"q`,
      `${CSI}1\"qX${CSI}0\"q`,
      `${CSI}4:3;58:2::255:0:0mX${CSI}0m`,
      `\x1b]8;;https://example.com\x07X\x1b]8;;\x07`,
    ]) {
      const source = createModel();
      try {
        await feed(source, setup);
        expect(() =>
          source.restore.restoreSerialization(source.serializer.serialize()),
        ).toThrow(/unsupported/u);
      } finally {
        dispose(source);
      }
    }
  });

  it("tracks CSI save and restore with numeric and subparameter forms", async () => {
    for (const params of ["5", "1:2;3"]) {
      const source = createModel(20, 8);
      const target = createModel(20, 8);
      try {
        await feed(
          source,
          `${CSI}31;1m${CSI}3;4H${CSI}${params}s${CSI}32;22m${CSI}6;10H`,
        );
        await restore(source, target);

        await feed(source, `${CSI}${params}uX`);
        await write(target.terminal, `${CSI}${params}uX`);
        expect(target.serializer.serialize()).toBe(source.serializer.serialize());
        expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
        expect(target.terminal.buffer.active.cursorY).toBe(source.terminal.buffer.active.cursorY);
      } finally {
        dispose(source);
        dispose(target);
      }
    }
  });

  it("restores DEC private 1048 position, SGR, and saved charset", async () => {
    const source = createModel(20, 8);
    const target = createModel(20, 8);
    try {
      await feed(
        source,
        `${CSI}31;1m\x1b(0${CSI}3;4H${CSI}?1048h` +
          `${CSI}32;22m\x1b(B${CSI}6;10H${CSI}?1048l`,
      );
      await restore(source, target);

      await feed(source, "q");
      await write(target.terminal, "q");
      const sourceCell = source.terminal.buffer.active.getLine(2)?.getCell(3);
      const targetCell = target.terminal.buffer.active.getLine(2)?.getCell(3);
      expect(targetCell?.getChars()).toBe("─");
      expect(targetCell?.getChars()).toBe(sourceCell?.getChars());
      expect(targetCell?.getFgColor()).toBe(1);
      expect(targetCell?.getFgColor()).toBe(sourceCell?.getFgColor());
      expect(Boolean(targetCell?.isBold())).toBe(true);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("injects 1049 saved SGR and charset before alternate-buffer serialization", async () => {
    const source = createModel(20, 8);
    const target = createModel(20, 8);
    try {
      await feed(
        source,
        `${CSI}31;1m\x1b(0${CSI}3;4H${CSI}?1049h` +
          `${CSI}32;22m\x1b(B${CSI}6;10Halternate`,
      );
      await restore(source, target);
      expect(target.terminal.buffer.active.type).toBe("alternate");

      await feed(source, `${CSI}?1049lq`);
      await write(target.terminal, `${CSI}?1049lq`);
      const sourceCell = source.terminal.buffer.normal.getLine(2)?.getCell(3);
      const targetCell = target.terminal.buffer.normal.getLine(2)?.getCell(3);
      expect(targetCell?.getChars()).toBe("─");
      expect(targetCell?.getChars()).toBe(sourceCell?.getChars());
      expect(targetCell?.getFgColor()).toBe(1);
      expect(targetCell?.getFgColor()).toBe(sourceCell?.getFgColor());
      expect(Boolean(targetCell?.isBold())).toBe(true);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("isolates alternate history from activation and final character state", async () => {
    const charsetSource = createModel(12, 5);
    const charsetTarget = createModel(12, 5);
    const sgrSource = createModel(12, 5);
    const sgrTarget = createModel(12, 5);
    const savedSource = createModel(12, 5);
    const savedTarget = createModel(12, 5);
    try {
      await feed(charsetSource, `${CSI}?47ha\x1b(0`);
      await restore(charsetSource, charsetTarget);
      expect(charsetTarget.terminal.buffer.alternate.getLine(0)?.getCell(0)?.getChars()).toBe(
        "a",
      );

      await feed(sgrSource, `${CSI}?47ha${CSI}31m`);
      await restore(sgrSource, sgrTarget);
      expect(sgrTarget.terminal.buffer.alternate.getLine(0)?.getCell(0)?.isFgDefault()).toBe(
        true,
      );

      await feed(savedSource, `${CSI}4m${CSI}?1049h${CSI}u`);
      await restore(savedSource, savedTarget);
      await feed(savedSource, "X");
      await write(savedTarget.terminal, "X");
      expect(
        Boolean(savedTarget.terminal.buffer.alternate.getLine(0)?.getCell(0)?.isUnderline()),
      ).toBe(false);
      expect(savedTarget.serializer.serialize()).toBe(savedSource.serializer.serialize());
    } finally {
      dispose(charsetSource);
      dispose(charsetTarget);
      dispose(sgrSource);
      dispose(sgrTarget);
      dispose(savedSource);
      dispose(savedTarget);
    }
  });

  it("recreates alternate-buffer blank-cell background from activation state", async () => {
    const source = createModel(12, 5);
    const target = createModel(12, 5);
    try {
      await feed(source, `${CSI}44m${CSI}?47h${CSI}u`);
      await restore(source, target);

      for (let row = 0; row < source.terminal.rows; row += 1) {
        expect(target.terminal.buffer.alternate.getLine(row)?.getCell(0)?.getBgColor()).toBe(
          source.terminal.buffer.alternate.getLine(row)?.getCell(0)?.getBgColor(),
        );
      }
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("recreates styled blank rows omitted from normal-buffer serialization", async () => {
    const source = createModel(12, 5);
    const target = createModel(12, 5);
    try {
      await feed(source, `${CSI}44m${CSI}2J${CSI}u`);
      await restore(source, target);

      for (let row = 0; row < source.terminal.rows; row += 1) {
        expect(target.terminal.buffer.normal.getLine(row)?.getCell(0)?.getBgColor()).toBe(
          source.terminal.buffer.normal.getLine(row)?.getCell(0)?.getBgColor(),
        );
      }
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores DEC G0-G3 designations and every GL locking shift", async () => {
    for (const setup of ["\x1b(0", "\x1b)0\x0e", "\x1b*0\x1bn", "\x1b+0\x1bo"]) {
      const source = createModel();
      const target = createModel();
      try {
        await feed(source, setup);
        await restore(source, target);
        await feed(source, "q");
        await write(target.terminal, "q");
        expect(target.terminal.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe("─");
        expect(target.serializer.serialize()).toBe(source.serializer.serialize());
      } finally {
        dispose(source);
        dispose(target);
      }
    }
  });

  it("restores VT300 aliases for the G1-G2 designation slots", async () => {
    for (const setup of ["\x1b-0\x0e", "\x1b.0\x1bn"]) {
      const source = createModel();
      const target = createModel();
      try {
        await feed(source, setup);
        await restore(source, target);
        await feed(source, "q");
        await write(target.terminal, "q");
        expect(target.terminal.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe("─");
      } finally {
        dispose(source);
        dispose(target);
      }
    }
  });

  it("matches xterm when it ignores the unsupported G3 slash alias", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(source, "\x1b/0\x1bo");
      await restore(source, target);
      await feed(source, "q");
      await write(target.terminal, "q");
      expect(target.terminal.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe("q");
      expect(target.serializer.serialize()).toBe(source.serializer.serialize());
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("inserts caller state before synchronized output and leaves continuation ordering available", async () => {
    const source = createModel();
    try {
      await feed(source, `${CSI}?2026h`);
      expect(
        source.restore
          .restoreSerialization("serialized", "title")
          .endsWith(`${CSI}?12l${CSI}20l${CSI}?25htitle${CSI}?2026h`),
      ).toBe(true);
    } finally {
      dispose(source);
    }
  });

  it("restores the resolved charset captured by DECSC", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(source, `\x1b(0${CSI}2;3H\x1b7\x1b(B${CSI}4;8H`);
      await restore(source, target);
      await feed(source, "\x1b8q");
      await write(target.terminal, "\x1b8q");
      expect(target.terminal.buffer.active.getLine(1)?.getCell(2)?.getChars()).toBe("─");
      expect(target.serializer.serialize()).toBe(source.serializer.serialize());
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores the initial saved charset without overwriting its designation", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(source, "\x1b(0\x1b8");
      await restore(source, target);

      await feed(source, "q");
      await write(target.terminal, "q");
      expect(target.serializer.serialize()).toBe(source.serializer.serialize());
      expect(target.terminal.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe("q");
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("fails closed when another buffer selected an unrestorable saved charset", async () => {
    const source = createModel(12, 5);
    try {
      await feed(source, `\x1b(0${CSI}?47;1049h\x1b%G${CSI}?1048l${CSI}?1047l`);

      expect(() =>
        source.restore.restoreSerialization(source.serializer.serialize()),
      ).toThrow(/current charset from its saved cursor state/u);
    } finally {
      dispose(source);
    }
  });

  it("preserves per-buffer custom tab stops across active-buffer DECSTR", async () => {
    const source = createModel(20, 8);
    const target = createModel(20, 8);
    try {
      await feed(
        source,
        `${CSI}3g${CSI}5G\x1bH${CSI}1G` +
          `${CSI}?1047h${CSI}3g${CSI}7G\x1bH${CSI}1G${CSI}!p`,
      );
      await restore(source, target);

      await feed(source, "\tA");
      await write(target.terminal, "\tA");
      expect(target.terminal.buffer.alternate.getLine(0)?.getCell(6)?.getChars()).toBe("A");
      expect(target.terminal.buffer.alternate.cursorX).toBe(
        source.terminal.buffer.alternate.cursorX,
      );

      await feed(source, `${CSI}?1047l${CSI}1G\tN`);
      await write(target.terminal, `${CSI}?1047l${CSI}1G\tN`);
      expect(target.terminal.buffer.normal.getLine(0)?.getCell(4)?.getChars()).toBe("N");
      expect(target.terminal.buffer.normal.cursorX).toBe(source.terminal.buffer.normal.cursorX);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("records C1 HTS after xterm applies it", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(source, `${CSI}3g${CSI}6G\x88`);
      await feed(source, `${CSI}1G`);
      await restore(source, target);

      await feed(source, "\tA");
      await write(target.terminal, "\tA");
      expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
      expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores a tab stop at a wrap-pending geometry boundary", async () => {
    const source = createModel(5, 4);
    const target = createModel(5, 4);
    try {
      await feed(source, "abcde\x88");
      await restore(source, target);
      source.terminal.resize(10, 4);
      target.terminal.resize(10, 4);

      const suffix = `${CSI}1G\tA`;
      await feed(source, suffix);
      await write(target.terminal, suffix);
      expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
      expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("resets alternate-buffer tabs after leaving a clearing alternate mode", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(
        source,
        `${CSI}?1047h${CSI}3g${CSI}6G\x1bH${CSI}?1047l${CSI}?1047h${CSI}1G`,
      );
      await restore(source, target);

      await feed(source, "\tA");
      await write(target.terminal, "\tA");
      expect(lines(target.terminal.buffer.alternate)).toEqual(lines(source.terminal.buffer.alternate));
      expect(target.terminal.buffer.alternate.cursorX).toBe(
        source.terminal.buffer.alternate.cursorX,
      );
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("resets alternate-buffer margins after leaving a clearing alternate mode", async () => {
    const source = createModel(10, 5);
    const target = createModel(10, 5);
    try {
      await feed(source, `${CSI}?1047h${CSI}2;4r${CSI}?1047l${CSI}?1047h`);
      await restore(source, target);

      const suffix = `1\r\n2\r\n3\r\n4\r\n5${CSI}5;1H\n`;
      await feed(source, suffix);
      await write(target.terminal, suffix);
      expect(lines(target.terminal.buffer.alternate)).toEqual(lines(source.terminal.buffer.alternate));
      expect(target.terminal.buffer.alternate.cursorY).toBe(
        source.terminal.buffer.alternate.cursorY,
      );
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("preserves the first alternate activation in a multi-parameter mode sequence", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(source, `${CSI}3;4H${CSI}?47;1049h`);
      await restore(source, target);

      await feed(source, `${CSI}?1049lX`);
      await write(target.terminal, `${CSI}?1049lX`);
      expect(lines(target.terminal.buffer.normal)).toEqual(lines(source.terminal.buffer.normal));
      expect(target.terminal.buffer.normal.cursorX).toBe(source.terminal.buffer.normal.cursorX);
      expect(target.terminal.buffer.normal.cursorY).toBe(source.terminal.buffer.normal.cursorY);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("preserves both saves in a multi-parameter 1049 and 1048 activation", async () => {
    const source = createModel();
    const target = createModel();
    try {
      await feed(source, `${CSI}3;4H${CSI}?1049;1048h${CSI}5;6H`);
      await restore(source, target);

      const suffix = `\x1b8A${CSI}?1049lB`;
      await feed(source, suffix);
      await write(target.terminal, suffix);
      expect(lines(target.terminal.buffer.alternate)).toEqual(lines(source.terminal.buffer.alternate));
      expect(lines(target.terminal.buffer.normal)).toEqual(lines(source.terminal.buffer.normal));
      expect(target.terminal.buffer.normal.cursorX).toBe(source.terminal.buffer.normal.cursorX);
      expect(target.terminal.buffer.normal.cursorY).toBe(source.terminal.buffer.normal.cursorY);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("does not home hidden normal state when restoring origin mode", async () => {
    const source = createModel(12, 5);
    const target = createModel(12, 5);
    try {
      await feed(source, `${CSI}2;4r${CSI}?47;1049h${CSI}?6h`);
      await restore(source, target);

      const suffix = `${CSI}?47lX`;
      await feed(source, suffix);
      await write(target.terminal, suffix);
      expect(lines(target.terminal.buffer.normal)).toEqual(lines(source.terminal.buffer.normal));
      expect(target.terminal.buffer.normal.cursorY).toBe(source.terminal.buffer.normal.cursorY);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores saved alternate-buffer state while the normal buffer is active", async () => {
    const source = createModel(12, 5);
    const target = createModel(12, 5);
    try {
      await feed(source, `${CSI}?1047h${CSI}3;4H\x1b7${CSI}=1u${CSI}?1047l`);
      await restore(source, target);

      const suffix = `${CSI}?1047h\x1b8X`;
      await feed(source, suffix);
      await write(target.terminal, suffix);
      expect(lines(target.terminal.buffer.alternate)).toEqual(lines(source.terminal.buffer.alternate));
      expect(target.restore.restoreSequence()).toBe(source.restore.restoreSequence());
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("bounds and preserves independent kitty keyboard stacks", async () => {
    const source = createModel();
    const target = createModel();
    try {
      const pushes = Array.from({ length: 65 }, (_, index) => `${CSI}>${index + 1}u`).join("");
      await feed(
        source,
        `${CSI}=1u${pushes}${CSI}<64u${CSI}?1047h${CSI}=2u${CSI}=4;2u${CSI}?1047l`,
      );
      await restore(source, target);
      expect(target.restore.restoreSequence()).toBe(source.restore.restoreSequence());

      await feed(source, `${CSI}<999999999u`);
      await target.restore.write(`${CSI}<999999999u`);
      expect(target.restore.restoreSequence()).toBe(source.restore.restoreSequence());
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("restores mouse encodings, cursor presentation, and option-backed modes", async () => {
    for (const setup of [
      `${CSI}?1006h${CSI}?12h${CSI}20h${CSI}5 q${CSI}?25l`,
      `${CSI}?1006h${CSI}?1016h${CSI}?12l${CSI}20l${CSI}4 q${CSI}?25h`,
    ]) {
      const source = createModel();
      const target = createModel();
      try {
        await feed(source, setup);
        await write(
          target.terminal,
          `${CSI}?1016h${CSI}?12h${CSI}20h${CSI}1 q${CSI}?25l`,
        );
        await restore(source, target);

        for (const mode of [12, 25, 1006, 1016]) {
          expect(await modeReport(target.terminal, mode)).toBe(
            await modeReport(source.terminal, mode),
          );
        }
        expect(await modeReport(target.terminal, 20, false)).toBe(
          await modeReport(source.terminal, 20, false),
        );
        expect(target.terminal.options.cursorBlink).toBe(source.terminal.options.cursorBlink);
        expect(target.terminal.options.convertEol).toBe(source.terminal.options.convertEol);
        const sourceModes = (
          source.terminal as unknown as {
            _core: { coreService: { decPrivateModes: unknown } };
          }
        )._core.coreService.decPrivateModes;
        const targetModes = (
          target.terminal as unknown as {
            _core: { coreService: { decPrivateModes: unknown } };
          }
        )._core.coreService.decPrivateModes;
        expect(targetModes).toEqual(sourceModes);
      } finally {
        dispose(source);
        dispose(target);
      }
    }
  });

  it("keeps hidden normal margins and DECSC state across alternate-buffer DECSTR", async () => {
    const source = createModel(20, 8);
    const target = createModel(20, 8);
    try {
      await feed(
        source,
        `${CSI}2;6r${CSI}31;1m${CSI}4;5H\x1b7${CSI}7;1H` +
          `${CSI}?1047h${CSI}3;7r${CSI}5;1H\x1b7${CSI}!p`,
      );
      await restore(source, target);
      await feed(source, `${CSI}?1047l\x1b8S`);
      await write(target.terminal, `${CSI}?1047l\x1b8S`);
      const savedCell = target.terminal.buffer.normal.getLine(3)?.getCell(4);
      expect(savedCell?.getChars()).toBe("S");
      expect(savedCell?.getFgColor()).toBe(1);
      expect(Boolean(savedCell?.isBold())).toBe(true);

      await feed(source, `${CSI}6;1H\n`);
      await write(target.terminal, `${CSI}6;1H\n`);
      expect(lines(target.terminal.buffer.normal)).toEqual(lines(source.terminal.buffer.normal));
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("fails closed when a saved cursor has scrolled above retained history", async () => {
    const source = createModel(20, 4, 3);
    try {
      await feed(source, `${CSI}!p${CSI}4H\n`);
      expect(() => source.restore.restoreSequence()).toThrow(
        /saved normal cursor above retained history/u,
      );
    } finally {
      dispose(source);
    }
  });

  it("keeps DECSC coordinates fixed when lines are inserted above them", async () => {
    const source = createModel(20, 6);
    const target = createModel(20, 6);
    try {
      await feed(
        source,
        `one\r\ntwo\r\nthree\r\nfour${CSI}3;2H\x1b7${CSI}1;1H${CSI}L`,
      );
      await restore(source, target);

      await feed(source, "\x1b8X");
      await write(target.terminal, "\x1b8X");
      expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
      expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
      expect(target.terminal.buffer.active.cursorY).toBe(source.terminal.buffer.active.cursorY);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("uses xterm's resized saved cursor X coordinate", async () => {
    const source = createModel(20, 4);
    const target = createModel(20, 4);
    try {
      await feed(source, `${CSI}2;16H\x1b7${CSI}1;1H`);
      source.terminal.resize(10, 4);
      source.terminal.resize(20, 4);
      await restore(source, target);

      await feed(source, "\x1b8X");
      await write(target.terminal, "\x1b8X");
      expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
      expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
      expect(target.terminal.buffer.active.cursorY).toBe(source.terminal.buffer.active.cursorY);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("fails closed for custom tab topology outside the current width", async () => {
    const source = createModel(20, 4);
    try {
      await feed(source, `${CSI}3g${CSI}16G\x1bH${CSI}1G`);
      source.terminal.resize(10, 4);
      expect(() =>
        source.restore.restoreSerialization(source.serializer.serialize()),
      ).toThrow(/Cannot restore normal tab stops outside the current 10-column geometry\./);
    } finally {
      dispose(source);
    }
  });

  it("allows retained default tab topology outside the current width", async () => {
    const source = createModel(20, 4);
    const target = createModel(10, 4);
    try {
      source.terminal.resize(10, 4);
      await restore(source, target);

      source.terminal.resize(20, 4);
      target.terminal.resize(20, 4);
      await feed(source, `${CSI}10G\tA`);
      await write(target.terminal, `${CSI}10G\tA`);
      expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
      expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
    } finally {
      dispose(source);
      dispose(target);
    }
  });

  it("drops custom margins when xterm resize resets them", async () => {
    const model = createModel();
    try {
      await feed(model, `${CSI}2;5r`);
      model.terminal.resize(30, 8);
      expect(model.restore.restoreSequence()).not.toContain(`${CSI}2;5r`);
    } finally {
      dispose(model);
    }
  });
});
