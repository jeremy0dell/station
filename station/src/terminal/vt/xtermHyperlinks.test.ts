import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { Terminal, type IBufferCell } from "@xterm/headless";
import { resolveXtermCellHyperlink } from "./xtermHyperlinks.js";

const terminals: Terminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose();
  }
});

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => {
    terminal.write(data, resolve);
  });
}

describe("resolveXtermCellHyperlink", () => {
  it("pins the @xterm/headless 6.0.0 private hyperlink invariant", async () => {
    const packageJson = JSON.parse(
      await readFile(
        new URL("../../../node_modules/@xterm/headless/package.json", import.meta.url),
        "utf8",
      ),
    ) as { version?: string };
    expect(packageJson.version).toBe("6.0.0");

    const terminal = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
    terminals.push(terminal);
    const uri = "https://example.com/exact?x=1#fragment";
    await write(terminal, `\x1b]8;id=contract;${uri}\x1b\\label\x1b]8;;\x1b\\`);

    const cell = terminal.buffer.active.getLine(0)?.getCell(0);
    expect(cell).toBeDefined();
    expect(resolveXtermCellHyperlink(terminal, cell as IBufferCell)).toBe(uri);
  });

  it("does not read stale extended attributes from a reused cell", async () => {
    const terminal = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
    terminals.push(terminal);
    await write(terminal, "\x1b]8;;https://example.com/linked\x1b\\A\x1b]8;;\x1b\\B");

    const line = terminal.buffer.active.getLine(0);
    const workCell = terminal.buffer.active.getNullCell();
    expect(resolveXtermCellHyperlink(terminal, line?.getCell(0, workCell) as IBufferCell)).toBe(
      "https://example.com/linked",
    );
    expect(resolveXtermCellHyperlink(terminal, line?.getCell(1, workCell) as IBufferCell)).toBeUndefined();
  });

  it("fails closed when the pinned private service is unavailable", () => {
    const cell = {
      hasExtendedAttrs: () => 1,
      extended: { urlId: 1 },
    } as unknown as IBufferCell;
    expect(resolveXtermCellHyperlink({} as Terminal, cell)).toBeUndefined();
  });
});
