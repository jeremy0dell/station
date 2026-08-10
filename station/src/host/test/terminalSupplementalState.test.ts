import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "bun:test";
import { createStationVtScreen } from "../../terminal/vt/screen.js";
import { TerminalSupplementalState } from "../terminalSupplementalState.js";

const CSI = "\x1b[";

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

function activeMargins(terminal: Terminal): { bottom: number; top: number } {
  const pinned = terminal as unknown as {
    _core: { _bufferService: { buffer: { scrollBottom: number; scrollTop: number } } };
  };
  return {
    bottom: pinned._core._bufferService.buffer.scrollBottom,
    top: pinned._core._bufferService.buffer.scrollTop,
  };
}

describe("TerminalSupplementalState", () => {
  it("restores margins and Station-relevant modes omitted by addon-serialize", async () => {
    const terminal = new Terminal({ cols: 12, rows: 6, allowProposedApi: true });
    const state = new TerminalSupplementalState(terminal);
    try {
      await write(
        terminal,
        `${CSI}2;5r${CSI}3;4H${CSI}?1002h${CSI}?1006h${CSI}?25l${CSI}>5u${CSI}?2026h`,
      );
      const restore = state.restoreSerialization("", "title");

      expect(restore).toContain(`${CSI}2;5r`);
      expect(restore).toContain(`${CSI}3;4H`);
      expect(restore).toContain(`${CSI}?1006h`);
      expect(restore).toContain(`${CSI}?25l`);
      expect(restore).toContain(`${CSI}>5u`);
      expect(restore.indexOf("title")).toBeLessThan(restore.indexOf(`${CSI}?2026h`));
    } finally {
      state.dispose();
      terminal.dispose();
    }
  });

  it("keeps kitty keyboard stacks per active buffer and clears them on RIS", async () => {
    const terminal = new Terminal({ cols: 12, rows: 6, allowProposedApi: true });
    const state = new TerminalSupplementalState(terminal);
    try {
      await write(terminal, `${CSI}=1u${CSI}>5u`);
      expect(state.restoreSerialization("")).toContain(`${CSI}=1u${CSI}>5u`);

      await write(terminal, `${CSI}?1049h${CSI}=7u`);
      const alternateRestore = state.restoreSerialization(`${CSI}?1049h${CSI}H`);
      expect(alternateRestore).toContain(`${CSI}=1u${CSI}>5u`);
      expect(alternateRestore).toContain(`${CSI}=7u`);

      await write(terminal, "\x1bc");
      expect(state.restoreSerialization("")).not.toContain("u");
    } finally {
      state.dispose();
      terminal.dispose();
    }
  });

  it("restores pixel mouse encoding and cursor presentation", async () => {
    const terminal = new Terminal({ cols: 12, rows: 6, allowProposedApi: true });
    const state = new TerminalSupplementalState(terminal);
    try {
      await write(terminal, `${CSI}?1016h${CSI}6 q`);
      const restore = state.restoreSerialization("");
      expect(restore).toContain(`${CSI}?1016h`);
      expect(restore).toContain(`${CSI}6 q`);
    } finally {
      state.dispose();
      terminal.dispose();
    }
  });

  it("builds content-free live reset VT with active modes and both Kitty stacks", async () => {
    const terminal = new Terminal({ cols: 12, rows: 6, allowProposedApi: true });
    const state = new TerminalSupplementalState(terminal);
    const responses: string[] = [];
    const target = createStationVtScreen({
      size: { cols: 12, rows: 6 },
      onResponse: (data) => responses.push(data),
    });
    try {
      await write(
        terminal,
        "normal-secret\x1b]2;private-title\x07" +
          `${CSI}=1u${CSI}>5u` +
          `${CSI}?1049h` +
          "alternate-secret" +
          `${CSI}=2u${CSI}>7u` +
          `${CSI}?1h${CSI}?66h${CSI}?2004h` +
          `${CSI}?1003h${CSI}?1006h${CSI}?1016h${CSI}?1004h` +
          `${CSI}?7l${CSI}?45h`,
      );

      const resetData = state.liveResetSequence();
      expect(resetData.startsWith("\x1bc")).toBe(true);
      expect(resetData).not.toContain("normal-secret");
      expect(resetData).not.toContain("alternate-secret");
      expect(resetData).not.toContain("private-title");

      target.feed(`dirty\x1b]2;dirty-title\x07${resetData}`);
      await target.whenIdle();

      expect(target.isAltScreen()).toBe(true);
      expect(target.isBracketedPasteEnabled()).toBe(true);
      expect(target.isApplicationCursorKeys()).toBe(true);
      expect(target.mouseProtocol()).toEqual({ tracking: "any", encoding: "sgr" });
      expect(target.isKittyKeyboardEnabled()).toBe(true);
      expect(target.getTitle()).toBeUndefined();
      expect(Array.from({ length: 6 }, (_, row) => target.rowText(row))).toEqual([
        "",
        "",
        "",
        "",
        "",
        "",
      ]);

      const modes = target.unsafeEngine.modes;
      expect(modes.applicationKeypadMode).toBe(true);
      expect(modes.sendFocusMode).toBe(true);
      expect(modes.wraparoundMode).toBe(false);
      expect(modes.reverseWraparoundMode).toBe(true);
      const pinned = target.unsafeEngine as unknown as {
        _core: { coreMouseService: { activeEncoding: string } };
      };
      expect(pinned._core.coreMouseService.activeEncoding).toBe("SGR_PIXELS");

      target.feed(
        `${CSI}?u${CSI}<u${CSI}?u` +
          `${CSI}?1049l${CSI}?u${CSI}<u${CSI}?u`,
      );
      await target.whenIdle();
      expect(responses).toEqual([`${CSI}?7u`, `${CSI}?2u`, `${CSI}?5u`, `${CSI}?1u`]);
    } finally {
      state.dispose();
      terminal.dispose();
      target.dispose();
    }
  });

  it("anchors degraded repaint to the active buffer cursor and origin region", async () => {
    for (const alternate of [false, true]) {
      const terminal = new Terminal({ cols: 12, rows: 6, allowProposedApi: true });
      const state = new TerminalSupplementalState(terminal);
      const target = createStationVtScreen({ size: { cols: 12, rows: 6 } });
      try {
        await write(
          terminal,
          (alternate ? `${CSI}?1049h` : "") + `${CSI}2;5r${CSI}?6h${CSI}3;7H`,
        );
        target.feed(state.liveResetSequence());
        await target.whenIdle();

        expect(target.isAltScreen()).toBe(alternate);
        expect(target.unsafeEngine.modes.originMode).toBe(true);
        expect(activeMargins(target.unsafeEngine)).toEqual({ bottom: 4, top: 1 });
        expect(target.cursor()).toEqual({
          x: terminal.buffer.active.cursorX,
          y: terminal.buffer.active.cursorY,
        });
      } finally {
        state.dispose();
        terminal.dispose();
        target.dispose();
      }
    }
  });

  it("normalizes a wrap-pending cursor to the last valid anchor cell", async () => {
    const terminal = new Terminal({ cols: 12, rows: 6, allowProposedApi: true });
    const state = new TerminalSupplementalState(terminal);
    const target = createStationVtScreen({ size: { cols: 12, rows: 6 } });
    try {
      await write(terminal, `${CSI}6;1Habcdefghijkl`);
      expect(terminal.buffer.active.cursorX).toBe(12);

      target.feed(state.liveResetSequence());
      await target.whenIdle();

      expect(target.cursor()).toEqual({ x: 11, y: 5 });
    } finally {
      state.dispose();
      terminal.dispose();
      target.dispose();
    }
  });

  it("restores hidden alternate Kitty state while ending in the normal buffer", async () => {
    const terminal = new Terminal({ cols: 12, rows: 6, allowProposedApi: true });
    const state = new TerminalSupplementalState(terminal);
    const responses: string[] = [];
    const target = createStationVtScreen({
      size: { cols: 12, rows: 6 },
      onResponse: (data) => responses.push(data),
    });
    try {
      await write(terminal, `${CSI}=3u${CSI}?47h${CSI}=7u${CSI}?47l`);
      target.feed(state.liveResetSequence());
      await target.whenIdle();

      expect(target.isAltScreen()).toBe(false);
      target.feed(`${CSI}?u${CSI}?47h${CSI}?u`);
      await target.whenIdle();
      expect(responses).toEqual([`${CSI}?3u`, `${CSI}?7u`]);
    } finally {
      state.dispose();
      terminal.dispose();
      target.dispose();
    }
  });
});
