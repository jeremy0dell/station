import { afterEach, describe, expect, it } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { nativeStationTheme, stationColorSnapshotValue } from "../../theme/index.js";
import { buildVisibleRows } from "./rows.js";
import { createStationVtScreen, type StationVtScreen } from "./screen.js";

describe("buildVisibleRows", () => {
  const cleanups: Array<() => void> = [];
  const screenWith = async (
    feed: string,
    size = { cols: 20, rows: 4 },
  ): Promise<StationVtScreen> => {
    const screen = createStationVtScreen({ size });
    cleanups.push(() => {
      screen.dispose();
    });
    screen.feed(feed);
    await screen.whenIdle();
    return screen;
  };
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("merges identically styled cells into one span", async () => {
    const screen = await screenWith("\x1b[31mabc\x1b[0mdef");
    const rows = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false });
    expect(rows[0]?.spans.length).toBe(2);
    expect(rows[0]?.spans[0]).toEqual({
      text: "abc",
      width: 3,
      fg: stationColorSnapshotValue(nativeStationTheme.terminal.ansi16[1]),
      attributes: 0,
    });
    expect(rows[0]?.spans[1]).toEqual({ text: "def", width: 3, attributes: 0 });
  });

  it("returns one entry per visible row", async () => {
    const screen = await screenWith("hello");
    const rows = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false });
    expect(rows.length).toBe(4);
    expect(rows[1]?.spans).toEqual([]);
  });

  it("paints the cursor cell inverse and hides it on request", async () => {
    const screen = await screenWith("ab");
    const withCursor = buildVisibleRows(screen.unsafeEngine, { cursorVisible: true });
    const cursorSpan = withCursor[0]?.spans[1];
    expect(cursorSpan?.attributes).toBe(TextAttributes.INVERSE);
    expect(cursorSpan?.width).toBe(1);

    const withoutCursor = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false });
    expect(withoutCursor[0]?.spans.length).toBe(1);
  });

  it("flips an inverse cell back to normal under the cursor", async () => {
    const screen = await screenWith("\x1b[7mX\x1b[0m\x1b[1;1H");
    const rows = buildVisibleRows(screen.unsafeEngine, { cursorVisible: true });
    expect(rows[0]?.spans[0]?.attributes).toBe(0);
  });

  it("clamps a pending-wrap cursor into the last column", async () => {
    const screen = await screenWith("x".repeat(20));
    const rows = buildVisibleRows(screen.unsafeEngine, { cursorVisible: true });
    const spans = rows[0]?.spans ?? [];
    const last = spans[spans.length - 1];
    expect(last?.attributes).toBe(TextAttributes.INVERSE);
  });

  it("moves the cursor inversion onto the owning wide cell", async () => {
    // Cursor placed onto the continuation column of a wide char must invert
    // the wide cell itself, not vanish.
    const screen = await screenWith("漢\x1b[1;2H");
    const rows = buildVisibleRows(screen.unsafeEngine, { cursorVisible: true });
    const first = rows[0]?.spans[0];
    expect(first?.text).toBe("漢");
    expect(first?.attributes).toBe(TextAttributes.INVERSE);
  });

  it("skips wide-char continuation cells but counts their width", async () => {
    const screen = await screenWith("漢X");
    const rows = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false });
    const spans = rows[0]?.spans ?? [];
    expect(spans[0]?.text).toBe("漢X");
    expect(spans[0]?.width).toBe(3);
  });

  it("carries a labeled OSC 8 URI on its span", async () => {
    const uri = "https://example.com/issues/247?exact=yes#label";
    const screen = await screenWith(`\x1b]8;;${uri}\x1b\\#247\x1b]8;;\x1b\\`);
    const span = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false })[0]?.spans[0];
    expect(span).toMatchObject({ text: "#247", width: 4, link: uri });
  });

  it("splits adjacent same-style cells when their URIs differ", async () => {
    const first = "https://example.com/first";
    const second = "mailto:second@example.com";
    const screen = await screenWith(
      `\x1b]8;;${first}\x1b\\A\x1b]8;;\x1b\\` + `\x1b]8;;${second}\x1b\\B\x1b]8;;\x1b\\`,
    );
    const spans = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false })[0]?.spans ?? [];
    expect(spans.map(({ text, link }) => ({ text, link }))).toEqual([
      { text: "A", link: first },
      { text: "B", link: second },
    ]);
  });

  it("preserves linked trailing spaces while trimming the unlinked row remainder", async () => {
    const uri = "file:///tmp/station%20link";
    const screen = await screenWith(`\x1b]8;;${uri}\x1b\\label  \x1b]8;;\x1b\\   `);
    const spans = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false })[0]?.spans ?? [];
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ text: "label  ", width: 7, link: uri });
  });

  it("keeps one URI across wide cells and soft-wrapped rows", async () => {
    const uri = "custom+opaque:wide/wrapped";
    const screen = await screenWith(`\x1b]8;;${uri}\x1b\\漢ABCD\x1b]8;;\x1b\\`, {
      cols: 4,
      rows: 3,
    });
    const rows = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false });
    expect(rows[0]?.spans[0]).toMatchObject({ text: "漢AB", width: 4, link: uri });
    expect(rows[1]?.spans[0]).toMatchObject({ text: "CD", width: 2, link: uri });
  });

  it("trims trailing plain whitespace but keeps styled whitespace", async () => {
    const screen = await screenWith("\x1b[44m  \x1b[0m   ");
    const rows = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false });
    const spans = rows[0]?.spans ?? [];
    expect(spans.length).toBe(1);
    expect(spans[0]).toEqual({
      text: "  ",
      width: 2,
      bg: stationColorSnapshotValue(nativeStationTheme.terminal.ansi16[4]),
      attributes: 0,
    });
  });

  const rowText = (row: { spans: Array<{ text: string }> } | undefined): string =>
    (row?.spans ?? []).map((span) => span.text).join("");

  it("renders scrolled-back history at a positive offset", async () => {
    // 10 single-line rows in a 4-row viewport: 6 land in scrollback.
    const screen = await screenWith(
      Array.from({ length: 10 }, (_, index) => `L${index}`).join("\r\n"),
      { cols: 20, rows: 4 },
    );
    const bottom = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false, offset: 0 });
    expect([rowText(bottom[0]), rowText(bottom[3])]).toEqual(["L6", "L9"]);

    const scrolled = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false, offset: 3 });
    expect([rowText(scrolled[0]), rowText(scrolled[3])]).toEqual(["L3", "L6"]);

    const top = buildVisibleRows(screen.unsafeEngine, { cursorVisible: false, offset: 99 });
    expect(rowText(top[0])).toBe("L0");
  });

  it("suppresses the cursor while scrolled back into history", async () => {
    const screen = await screenWith(
      Array.from({ length: 10 }, (_, index) => `L${index}`).join("\r\n"),
      { cols: 20, rows: 4 },
    );
    const scrolled = buildVisibleRows(screen.unsafeEngine, { cursorVisible: true, offset: 3 });
    const anyInverse = scrolled.some((row) =>
      row.spans.some((span) => (span.attributes & TextAttributes.INVERSE) !== 0),
    );
    expect(anyInverse).toBe(false);
  });
});
