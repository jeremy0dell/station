// The vt model measures cells with Unicode-11 tables while OpenTUI's native
// drawText advances by modern grapheme widths, so emoji-bearing rows can paint
// wider than the columns the renderable accounted for. A previous bug had no
// scissor at the pane edge, so those tails escaped into the pane border and
// neighboring panes; renderSelf now clips all paint to its own bounds.
import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createStationVtScreen, type StationVtScreen } from "./vt/screen.js";
import "./TerminalScreenRenderable.js";

const VS16_WARNING = "⚠️"; // U+26A0 + VS16: 1 cell in Unicode-11, painted 2
const POST_U11_MELT = "\u{1FAE0}"; // 🫠 (Unicode 14): unknown to U11 tables, painted 2

const PANE_COLS = 10;
const FRAME = { width: 26, height: 3 };

type Mounted = {
  setup: Awaited<ReturnType<typeof testRender>>;
  screen: StationVtScreen;
};

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    teardown();
  }
});

/** Mount the renderable at PANE_COLS wide inside a wider frame, as TerminalPane does. */
async function mountNarrowPane(feed: string): Promise<Mounted> {
  const screen = createStationVtScreen({ size: { cols: PANE_COLS, rows: FRAME.height } });
  screen.feed(`\x1b[?25l${feed}`); // hide the cursor so only fed glyphs paint
  await screen.whenIdle();
  const setup = await testRender(
    createElement("terminalScreen", { screen, width: PANE_COLS, height: "100%" }),
    FRAME,
  );
  teardowns.push(() => {
    setup.renderer.destroy();
    screen.dispose();
  });
  await setup.flush();
  return { setup, screen };
}

/**
 * Rightmost painted cell column + 1 on frame row 0. Trailing blank cells emit
 * one literal space char each in the char frame (wide-glyph continuation cells
 * emit nothing), so counting trailing space chars is cell-accurate.
 */
function paintedExtent(setup: Mounted["setup"]): number {
  const line = setup.captureCharFrame().split("\n")[0] ?? "";
  const trailingSpaces = (/ *$/u.exec(line)?.[0] ?? "").length;
  return FRAME.width - trailingSpaces;
}

describe("renderSelf scissors paint to the pane bounds", () => {
  it("clips a VS16 emoji row that the vt model believes fits the pane exactly", async () => {
    // 10 x ⚠️: span.width 10 (fills the pane, so no span-level clip) but the
    // native paint is 2 cells each — the scissor must contain the overhang.
    // Containment is asserted on the char frame (cell-accurate); captureSpans
    // splits style runs mid-grapheme at the scissor edge and misattributes
    // in-pane glyphs, so span-based checks are unreliable here.
    const { setup } = await mountNarrowPane(VS16_WARNING.repeat(PANE_COLS));
    expect(paintedExtent(setup)).toBeLessThanOrEqual(PANE_COLS);
  });

  it("clips a post-Unicode-11 emoji row the same way", async () => {
    const { setup } = await mountNarrowPane(POST_U11_MELT.repeat(PANE_COLS));
    expect(paintedExtent(setup)).toBeLessThanOrEqual(PANE_COLS);
  });

  it("control: an ASCII row filling the pane paints exactly to the pane edge", async () => {
    const { setup } = await mountNarrowPane("ABCDEFGHIJ");
    expect(setup.captureCharFrame().split("\n")[0] ?? "").toContain("ABCDEFGHIJ");
    expect(paintedExtent(setup)).toBe(PANE_COLS);
  });

  it("control: a CJK row filling the pane paints exactly to the pane edge", async () => {
    // 5 x 漢 = 10 cells in both width tables; agreement keeps the paint inside.
    const { setup } = await mountNarrowPane("漢".repeat(5));
    expect(setup.captureCharFrame().split("\n")[0] ?? "").toContain("漢漢漢漢漢");
    expect(paintedExtent(setup)).toBe(PANE_COLS);
  });
});
