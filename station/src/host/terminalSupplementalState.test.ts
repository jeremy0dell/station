import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "bun:test";
import { TerminalSupplementalState } from "./terminalSupplementalState.js";

const CSI = "\x1b[";

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
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
});
