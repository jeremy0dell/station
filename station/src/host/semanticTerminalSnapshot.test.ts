import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { type IBuffer, Terminal } from "@xterm/headless";
import { describe, expect, it } from "bun:test";
import { createStationVtScreen } from "../terminal/vt/screen.js";
import { TerminalRestoreState } from "./terminalRestoreState.js";
import { SemanticTerminalSnapshot } from "./semanticTerminalSnapshot.js";
import { TERMINAL_SEQUENCE_CONTINUATION_MAX_CODE_UNITS } from "./terminalSequenceContinuation.js";

const CSI = "\x1b[";
const RIS = "\x1bc";

type Model = {
  terminal: Terminal;
  serializer: SerializeAddon;
};

function createModel(cols = 20, rows = 5, scrollback = 100): Model {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
    logLevel: "off",
  });
  terminal.loadAddon(new Unicode11Addon() as never);
  terminal.unicode.activeVersion = "11";
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer as never);
  return { terminal, serializer };
}

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

function lines(buffer: IBuffer): string[] {
  return Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
  );
}

function sgrFromSerialization(serialized: string): string {
  return [...serialized.matchAll(/\x1b\[[0-9;]*m/g)].map((match) => match[0]).join("");
}

function currentSgr(model: Model): string {
  const buffer = model.terminal.buffer.active;
  return sgrFromSerialization(
    model.serializer.serialize({
      range: { start: buffer.baseY + buffer.cursorY, end: buffer.baseY + buffer.cursorY },
    }),
  );
}

async function modeReport(terminal: Terminal, mode: number): Promise<string> {
  const replies: string[] = [];
  const subscription = terminal.onData((data) => replies.push(data));
  try {
    await write(terminal, `${CSI}?${mode}$p`);
    return replies.join("");
  } finally {
    subscription.dispose();
  }
}

describe("Gate 0: @xterm/addon-serialize 0.13.0 characterization", () => {
  it("round-trips the normal buffer, retained scrollback, cursor, and current SGR", async () => {
    const source = createModel(20, 4);
    const target = createModel(20, 4);
    try {
      await write(
        source.terminal,
        Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join("\r\n") +
          `${CSI}31;1m${CSI}2;6H`,
      );
      await write(target.terminal, RIS + source.serializer.serialize());

      expect(lines(target.terminal.buffer.normal)).toEqual(lines(source.terminal.buffer.normal));
      expect(target.terminal.buffer.normal.baseY).toBe(source.terminal.buffer.normal.baseY);
      expect(target.terminal.buffer.normal.cursorX).toBe(source.terminal.buffer.normal.cursorX);
      expect(target.terminal.buffer.normal.cursorY).toBe(source.terminal.buffer.normal.cursorY);

      await write(source.terminal, "S");
      await write(target.terminal, "S");
      const sourceCell = source.terminal.buffer.normal
        .getLine(source.terminal.buffer.normal.baseY + source.terminal.buffer.normal.cursorY)
        ?.getCell(source.terminal.buffer.normal.cursorX - 1);
      const targetCell = target.terminal.buffer.normal
        .getLine(target.terminal.buffer.normal.baseY + target.terminal.buffer.normal.cursorY)
        ?.getCell(target.terminal.buffer.normal.cursorX - 1);
      expect(targetCell?.getFgColor()).toBe(sourceCell?.getFgColor());
      expect(Boolean(targetCell?.isBold())).toBe(true);
    } finally {
      source.terminal.dispose();
      target.terminal.dispose();
    }
  });

  it("round-trips an active alternate buffer and its hidden normal history", async () => {
    const source = createModel(20, 4);
    const target = createModel(20, 4);
    try {
      await write(
        source.terminal,
        `${Array.from({ length: 7 }, (_, index) => `normal-${index + 1}`).join("\r\n")}${CSI}?1049h${CSI}Halternate`,
      );
      await write(target.terminal, RIS + source.serializer.serialize());

      expect(target.terminal.buffer.active.type).toBe("alternate");
      expect(lines(target.terminal.buffer.normal)).toEqual(lines(source.terminal.buffer.normal));
      expect(lines(target.terminal.buffer.alternate)).toEqual(
        lines(source.terminal.buffer.alternate),
      );
    } finally {
      source.terminal.dispose();
      target.terminal.dispose();
    }
  });

  it("round-trips application cursor/keypad, bracketed paste, and every mouse tracker", async () => {
    for (const [sequence, expected] of [
      [`${CSI}?9h`, "x10"],
      [`${CSI}?1000h`, "vt200"],
      [`${CSI}?1002h`, "drag"],
      [`${CSI}?1003h`, "any"],
    ] as const) {
      const source = createModel();
      const target = createModel();
      try {
        await write(source.terminal, `${CSI}?1h\x1b=${CSI}?2004h${sequence}`);
        await write(target.terminal, RIS + source.serializer.serialize());
        expect(target.terminal.modes).toMatchObject({
          applicationCursorKeysMode: true,
          applicationKeypadMode: true,
          bracketedPasteMode: true,
          mouseTrackingMode: expected,
        });
      } finally {
        source.terminal.dispose();
        target.terminal.dispose();
      }
    }
  });

  it("identifies the exact modes that require Station's supplemental restore state", async () => {
    const source = createModel();
    const target = createModel();
    const fullStream = `${CSI}?25l${CSI}?1002h${CSI}?1006h${CSI}>5u${CSI}2;4r${CSI}?2026h`;
    const tracker = new TerminalRestoreState(source.terminal, source.serializer);
    try {
      await tracker.write(fullStream);
      const serialized = source.serializer.serialize();

      expect(serialized).not.toContain(`${CSI}?25l`);
      expect(serialized).not.toContain(`${CSI}?1006h`);
      expect(serialized).not.toContain(`${CSI}>5u`);
      expect(serialized).not.toContain(`${CSI}2;4r`);
      expect(serialized).not.toContain(`${CSI}?2026h`);
      expect(tracker.restoreSequence()).toContain(`${CSI}?25l`);
      expect(tracker.restoreSequence()).toContain(`${CSI}?1006h`);
      expect(tracker.restoreSequence()).toContain(`${CSI}>5u`);

      await write(target.terminal, RIS + serialized + tracker.restoreSequence());
      expect(await modeReport(target.terminal, 25)).toContain(`${CSI}?25;2$y`);
      expect(await modeReport(target.terminal, 1006)).toContain(`${CSI}?1006;1$y`);
      expect(target.terminal.modes.synchronizedOutputMode).toBe(true);
    } finally {
      tracker.dispose();
      source.terminal.dispose();
      target.terminal.dispose();
    }
  });

  it("can restore DECSC position and SGR through public parser and serializer APIs", async () => {
    const source = createModel(20, 8);
    const target = createModel(20, 8);
    let saved: { x: number; y: number; sgr: string } | undefined;
    const subscription = source.terminal.parser.registerEscHandler({ final: "7" }, () => {
      const buffer = source.terminal.buffer.active;
      saved = { x: buffer.cursorX, y: buffer.cursorY, sgr: currentSgr(source) };
      return false;
    });
    try {
      await write(
        source.terminal,
        `${CSI}31;1m${CSI}3;4H\x1b7${CSI}32;22m${CSI}6;10Hcurrent`,
      );
      expect(saved).toBeDefined();
      if (saved === undefined) {
        return;
      }
      const snapshot = source.serializer.serialize();
      const current = {
        x: source.terminal.buffer.active.cursorX,
        y: source.terminal.buffer.active.cursorY,
        sgr: currentSgr(source),
      };
      const savedRestore =
        `${CSI}${saved.y + 1};${saved.x + 1}H${CSI}0m${saved.sgr}\x1b7` +
        `${CSI}${current.y + 1};${current.x + 1}H${CSI}0m${current.sgr}`;

      await write(target.terminal, RIS + snapshot + savedRestore);
      expect(target.terminal.buffer.active.cursorX).toBe(current.x);
      expect(target.terminal.buffer.active.cursorY).toBe(current.y);
      await write(target.terminal, "C\x1b8S");

      const currentCell = target.terminal.buffer.active
        .getLine(target.terminal.buffer.active.baseY + current.y)
        ?.getCell(current.x);
      const savedCell = target.terminal.buffer.active
        .getLine(target.terminal.buffer.active.baseY + saved.y)
        ?.getCell(saved.x);
      expect(currentCell?.getFgColor()).toBe(2);
      expect(Boolean(currentCell?.isBold())).toBe(false);
      expect(savedCell?.getFgColor()).toBe(1);
      expect(Boolean(savedCell?.isBold())).toBe(true);
    } finally {
      subscription.dispose();
      source.terminal.dispose();
      target.terminal.dispose();
    }
  });

  it("restores DECSTBM behavior and synchronized output with supplemental public VT", async () => {
    const source = createModel(20, 6);
    const target = createModel(20, 6);
    try {
      const initial = `${CSI}H${["one", "two", "three", "four", "five", "six"].join("\r\n")}`;
      await write(source.terminal, initial + `${CSI}2;5r${CSI}?2026h`);
      await write(
        target.terminal,
        RIS + source.serializer.serialize() + `${CSI}2;5r${CSI}?2026h`,
      );

      expect(target.terminal.modes.synchronizedOutputMode).toBe(true);
      await write(source.terminal, `${CSI}5;1H\n${CSI}?2026l`);
      await write(target.terminal, `${CSI}5;1H\n${CSI}?2026l`);
      expect(lines(target.terminal.buffer.normal)).toEqual(lines(source.terminal.buffer.normal));
    } finally {
      source.terminal.dispose();
      target.terminal.dispose();
    }
  });

  it("restores identically onto fresh and dirty clients when prefixed by RIS", async () => {
    const source = createModel(20, 4);
    const fresh = createModel(20, 4);
    const dirty = createModel(20, 4);
    try {
      await write(
        source.terminal,
        Array.from({ length: 8 }, (_, index) => `source-${index + 1}`).join("\r\n"),
      );
      await write(
        dirty.terminal,
        `${CSI}?1003h${CSI}45m${Array.from({ length: 12 }, (_, index) => `dirty-${index + 1}`).join("\r\n")}`,
      );
      const restoration = RIS + source.serializer.serialize();
      await write(fresh.terminal, restoration);
      await write(dirty.terminal, restoration);

      expect(lines(dirty.terminal.buffer.normal)).toEqual(lines(fresh.terminal.buffer.normal));
      expect(dirty.terminal.modes).toEqual(fresh.terminal.modes);
      expect(dirty.terminal.buffer.normal.baseY).toBe(fresh.terminal.buffer.normal.baseY);
    } finally {
      source.terminal.dispose();
      fresh.terminal.dispose();
      dirty.terminal.dispose();
    }
  });

  it("round-trips resize/reflow and Unicode 11 cell widths", async () => {
    const source = createModel(10, 4);
    const target = createModel(20, 4);
    try {
      await write(source.terminal, "0123456789ABCDEFGHIJ🙂界-end");
      source.terminal.resize(20, 4);
      await write(target.terminal, RIS + source.serializer.serialize());

      expect(target.terminal.unicode.activeVersion).toBe("11");
      expect(lines(target.terminal.buffer.normal)).toEqual(lines(source.terminal.buffer.normal));
      expect(target.terminal.buffer.normal.cursorX).toBe(source.terminal.buffer.normal.cursorX);
      expect(target.terminal.buffer.normal.cursorY).toBe(source.terminal.buffer.normal.cursorY);

      source.terminal.resize(12, 5);
      target.terminal.resize(12, 5);
      expect(lines(target.terminal.buffer.normal)).toEqual(lines(source.terminal.buffer.normal));
    } finally {
      source.terminal.dispose();
      target.terminal.dispose();
    }
  });
});

describe("SemanticTerminalSnapshot", () => {
  it("captures a self-contained restoration that replaces a dirty screen", async () => {
    const semantic = new SemanticTerminalSnapshot(20, 4);
    const fresh = createModel(20, 4);
    const dirty = createModel(20, 4);
    try {
      semantic.write(
        Array.from({ length: 8 }, (_, index) => `source-${index + 1}`).join("\r\n") +
          `${CSI}?25l${CSI}?1006h`,
      );
      await write(dirty.terminal, `${CSI}?1003h${CSI}45m${"dirty\r\n".repeat(12)}`);
      const restoration = (await semantic.capture()).join("");
      await write(fresh.terminal, restoration);
      await write(dirty.terminal, restoration);

      expect(lines(dirty.terminal.buffer.normal)).toEqual(lines(fresh.terminal.buffer.normal));
      expect(dirty.terminal.buffer.normal.baseY).toBe(fresh.terminal.buffer.normal.baseY);
      expect(dirty.terminal.modes).toEqual(fresh.terminal.modes);
      expect(await modeReport(dirty.terminal, 25)).toContain(`${CSI}?25;2$y`);
    } finally {
      semantic.dispose();
      fresh.terminal.dispose();
      dirty.terminal.dispose();
    }
  });

  it("places capture in the write queue so later output is excluded from the boundary", async () => {
    const semantic = new SemanticTerminalSnapshot(20, 4);
    const atBoundary = createModel(20, 4);
    const afterBoundary = createModel(20, 4);
    try {
      semantic.write("before");
      const capture = semantic.capture();
      semantic.write("-after");
      await write(atBoundary.terminal, (await capture).join(""));
      await write(afterBoundary.terminal, (await semantic.capture()).join(""));

      expect(lines(atBoundary.terminal.buffer.normal).join("\n")).toContain("before");
      expect(lines(atBoundary.terminal.buffer.normal).join("\n")).not.toContain("after");
      expect(lines(afterBoundary.terminal.buffer.normal).join("\n")).toContain("before-after");
    } finally {
      semantic.dispose();
      atBoundary.terminal.dispose();
      afterBoundary.terminal.dispose();
    }
  });

  it("restores an alternate screen with its hidden normal-buffer history", async () => {
    const semantic = new SemanticTerminalSnapshot(20, 4);
    const target = createModel(20, 4, 100);
    try {
      semantic.write(
        `${Array.from({ length: 7 }, (_, index) => `normal-${index + 1}`).join("\r\n")}${CSI}?1049h${CSI}Halternate`,
      );
      await write(target.terminal, (await semantic.capture()).join(""));

      expect(target.terminal.buffer.active.type).toBe("alternate");
      expect(lines(target.terminal.buffer.normal).join("\n")).toContain("normal-1");
      expect(lines(target.terminal.buffer.normal).join("\n")).toContain("normal-7");
      expect(lines(target.terminal.buffer.alternate).join("\n")).toContain("alternate");
    } finally {
      semantic.dispose();
      target.terminal.dispose();
    }
  });

  it("retains numbered non-repainting history beyond the 256 KiB raw-ring budget", async () => {
    const semantic = new SemanticTerminalSnapshot(80, 24);
    const target = createModel(80, 24, 10_000);
    try {
      semantic.write(
        Array.from(
          { length: 4_000 },
          (_, index) => `numbered-${String(index + 1).padStart(4, "0")} ${"x".repeat(64)}`,
        ).join("\r\n"),
      );
      await write(target.terminal, (await semantic.capture()).join(""));
      const restored = lines(target.terminal.buffer.normal).join("\n");

      expect(restored).toContain("numbered-0001");
      expect(restored).toContain("numbered-4000");
    } finally {
      semantic.dispose();
      target.terminal.dispose();
    }
  });

  it("stays bounded across repeated captures after the 10,000-line cap", async () => {
    const semantic = new SemanticTerminalSnapshot(80, 24);
    try {
      semantic.write(
        Array.from({ length: 10_050 }, (_, index) => `line-${index}`).join("\r\n"),
      );
      const saturated = (await semantic.capture()).join("");
      semantic.write(
        Array.from({ length: 2_000 }, (_, index) => `post-cap-${index}`).join("\r\n"),
      );
      const first = (await semantic.capture()).join("");
      const second = (await semantic.capture()).join("");

      expect(second).toBe(first);
      expect(first.length).toBeLessThan(saturated.length + 100_000);
    } finally {
      semantic.dispose();
    }
  });

  it("continues a split CSI without replaying controls already applied to the model", async () => {
    const semantic = new SemanticTerminalSnapshot(20, 4);
    const source = createModel(20, 4);
    const target = createModel(20, 4);
    try {
      const prefix = `AB${CSI}31\b`;
      semantic.write(prefix);
      await write(source.terminal, prefix);

      const restoration = (await semantic.capture()).join("");
      expect(restoration.endsWith(`${CSI}31`)).toBe(true);
      await write(target.terminal, restoration);

      await write(source.terminal, "mX");
      await write(target.terminal, "mX");
      expect(lines(target.terminal.buffer.normal)).toEqual(lines(source.terminal.buffer.normal));
      expect(target.terminal.buffer.normal.cursorX).toBe(source.terminal.buffer.normal.cursorX);
      expect(target.terminal.buffer.normal.getLine(0)?.getCell(1)?.getFgColor()).toBe(1);
    } finally {
      semantic.dispose();
      source.terminal.dispose();
      target.terminal.dispose();
    }
  });

  it("records C1 HTS at the cursor reached earlier in the same PTY chunk", async () => {
    const semantic = new SemanticTerminalSnapshot(20, 4);
    const source = createModel(20, 4);
    const target = createModel(20, 4);
    try {
      const setup = `${CSI}3g${CSI}6G\x88${CSI}1G`;
      semantic.write(setup);
      await write(source.terminal, setup);
      await write(target.terminal, (await semantic.capture()).join(""));

      await write(source.terminal, "\tA");
      await write(target.terminal, "\tA");
      expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
      expect(target.terminal.buffer.active.getLine(0)?.getCell(5)?.getChars()).toBe("A");
    } finally {
      semantic.dispose();
      source.terminal.dispose();
      target.terminal.dispose();
    }
  });

  it("continues split OSC and DCS sequences after restoration", async () => {
    const oscSemantic = new SemanticTerminalSnapshot(20, 4);
    const oscTarget = createModel(20, 4);
    const dcsSemantic = new SemanticTerminalSnapshot(20, 4);
    const dcsTarget = createModel(20, 4);
    let title = "";
    const dcsReplies: string[] = [];
    const titleSubscription = oscTarget.terminal.onTitleChange((next) => {
      title = next;
    });
    const dcsSubscription = dcsTarget.terminal.onData((data) => {
      dcsReplies.push(data);
    });
    try {
      oscSemantic.write("\x1b]2;new-title");
      const oscRestoration = (await oscSemantic.capture()).join("");
      expect(oscRestoration.endsWith("\x1b]2;new-title")).toBe(true);
      await write(oscTarget.terminal, oscRestoration);
      await write(oscTarget.terminal, "\x07");
      expect(title).toBe("new-title");

      dcsSemantic.write("\x1bP$q");
      const dcsRestoration = (await dcsSemantic.capture()).join("");
      expect(dcsRestoration.endsWith("\x1bP$q")).toBe(true);
      await write(dcsTarget.terminal, dcsRestoration);
      await write(dcsTarget.terminal, "m\x1b\\");
      expect(dcsReplies.join("")).toBe("\x1bP1$r0m\x1b\\");
    } finally {
      titleSubscription.dispose();
      dcsSubscription.dispose();
      oscSemantic.dispose();
      oscTarget.terminal.dispose();
      dcsSemantic.dispose();
      dcsTarget.terminal.dispose();
    }
  });

  it("preserves xterm's write-scoped DCS DEL payload behavior", async () => {
    const semantic = new SemanticTerminalSnapshot(20, 4);
    const source = createModel(20, 4);
    const target = createModel(20, 4);
    const sourceReplies: string[] = [];
    const targetReplies: string[] = [];
    const sourceSubscription = source.terminal.onData((data) => sourceReplies.push(data));
    const targetSubscription = target.terminal.onData((data) => targetReplies.push(data));
    try {
      const setup = "\x1bP$qm\x7f";
      semantic.write(setup);
      await write(source.terminal, setup);
      await write(target.terminal, (await semantic.capture()).join(""));

      await write(source.terminal, "\x1b\\");
      await write(target.terminal, "\x1b\\");
      expect(targetReplies).toEqual(sourceReplies);
      expect(targetReplies.join("")).toBe("\x1bP0$r\x1b\\");
    } finally {
      sourceSubscription.dispose();
      targetSubscription.dispose();
      semantic.dispose();
      source.terminal.dispose();
      target.terminal.dispose();
    }
  });

  it("does not turn an emitted lone high surrogate into pending decoder state", async () => {
    const semantic = new SemanticTerminalSnapshot(20, 4);
    const source = createModel(20, 4);
    const target = createModel(20, 4);
    let sourceTitle = "";
    let targetTitle = "";
    const sourceSubscription = source.terminal.onTitleChange((title) => {
      sourceTitle = title;
    });
    const targetSubscription = target.terminal.onTitleChange((title) => {
      targetTitle = title;
    });
    try {
      const setup = "\x1b]2;x\ud83d\0";
      semantic.write(setup);
      await write(source.terminal, setup);
      await write(target.terminal, (await semantic.capture()).join(""));

      const suffix = "\ufeffy\x07";
      await write(source.terminal, suffix);
      await write(target.terminal, suffix);
      expect(targetTitle).toBe(sourceTitle);
      expect(targetTitle).toBe("x\ud83dy");
    } finally {
      sourceSubscription.dispose();
      targetSubscription.dispose();
      semantic.dispose();
      source.terminal.dispose();
      target.terminal.dispose();
    }
  });

  it("returns ignored SOS, PM, and APC strings to ground on non-ASCII input", async () => {
    for (const introducer of ["\x1bX", "\x1b^", "\x1b_"]) {
      const semantic = new SemanticTerminalSnapshot(20, 4);
      const source = createModel(20, 4);
      const target = createModel(20, 4);
      try {
        const setup = `${introducer}ignoredé`;
        semantic.write(setup);
        await write(source.terminal, setup);
        await write(target.terminal, (await semantic.capture()).join(""));
        await write(source.terminal, "X");
        await write(target.terminal, "X");
        expect(lines(target.terminal.buffer.active)).toEqual(lines(source.terminal.buffer.active));
      } finally {
        semantic.dispose();
        source.terminal.dispose();
        target.terminal.dispose();
      }
    }
  });

  it("canonicalizes cursor visibility for Station's RIS semantics and dirty clients", async () => {
    const resetVisible = new SemanticTerminalSnapshot(20, 4);
    const defaultVisible = new SemanticTerminalSnapshot(20, 4);
    const resetTarget = createStationVtScreen({ size: { cols: 20, rows: 4 } });
    const dirtyTarget = createStationVtScreen({ size: { cols: 20, rows: 4 } });
    try {
      resetVisible.write(`${CSI}?25l${RIS}`);
      resetTarget.feed((await resetVisible.capture()).join(""));
      dirtyTarget.feed(`${CSI}?25l`);
      dirtyTarget.feed((await defaultVisible.capture()).join(""));
      await resetTarget.whenIdle();
      await dirtyTarget.whenIdle();

      expect(resetTarget.isCursorVisible()).toBe(true);
      expect(dirtyTarget.isCursorVisible()).toBe(true);
    } finally {
      resetVisible.dispose();
      defaultVisible.dispose();
      resetTarget.dispose();
      dirtyTarget.dispose();
    }
  });

  it("restores completed OSC titles, including empty, and clears them on RIS", async () => {
    const semantic = new SemanticTerminalSnapshot(20, 4);
    const target = createModel(20, 4);
    let title = "dirty";
    const subscription = target.terminal.onTitleChange((next) => {
      title = next;
    });
    try {
      await write(target.terminal, "\x1b]2;dirty\x07");
      semantic.write("\x1b]2;working\x07");
      await write(target.terminal, (await semantic.capture()).join(""));
      expect(title).toBe("working");

      semantic.write("\x1b]2;\x07");
      await write(target.terminal, (await semantic.capture()).join(""));
      expect(title).toBe("");

      semantic.write("\x1b]2;again\x07\x1bc");
      await write(target.terminal, (await semantic.capture()).join(""));
      expect(title).toBe("");
    } finally {
      subscription.dispose();
      semantic.dispose();
      target.terminal.dispose();
    }
  });

  it("restores the title before synchronized output and parser continuation last", async () => {
    const semantic = new SemanticTerminalSnapshot(20, 4);
    try {
      semantic.write("\x1b]2;working\x07\x1b[?2026h\x1b[31");
      const restoration = (await semantic.capture()).join("");
      const titleIndex = restoration.indexOf("\x1b]2;working\x07");
      const syncIndex = restoration.lastIndexOf("\x1b[?2026h");

      expect(titleIndex).toBeGreaterThanOrEqual(0);
      expect(syncIndex).toBeGreaterThan(titleIndex);
      expect(restoration.endsWith("\x1b[31")).toBe(true);
    } finally {
      semantic.dispose();
    }
  });

  it("rejects capture after a 1 MiB unfinished sequence and recovers at termination", async () => {
    const semantic = new SemanticTerminalSnapshot(20, 4);
    const target = createModel(20, 4);
    let title = "";
    const subscription = target.terminal.onTitleChange((next) => {
      title = next;
    });
    try {
      semantic.write(
        `\x1b]2;${"x".repeat(TERMINAL_SEQUENCE_CONTINUATION_MAX_CODE_UNITS)}`,
      );
      await expect(semantic.capture()).rejects.toMatchObject({
        message:
          "Unfinished terminal sequence exceeds the 1048576-code-unit capture limit.",
      });

      semantic.write("\x07\x1b]2;recovered\x07");
      await write(target.terminal, (await semantic.capture()).join(""));
      expect(title).toBe("recovered");
    } finally {
      subscription.dispose();
      semantic.dispose();
      target.terminal.dispose();
    }
  });
});
