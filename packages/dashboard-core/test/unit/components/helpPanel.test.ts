import { describe, expect, it } from "vitest";
import {
  helpOverlayContent,
  helpOverlayLineCount,
} from "../../../src/components/HelpOverlay/content.js";
import {
  clampHelpScrollOffset,
  helpPanelBodyRows,
  helpPanelLines,
  helpPanelModel,
  joinHelpPanelLine,
} from "../../../src/components/HelpOverlay/helpPanel.js";
import { VERTICAL_SCROLLBAR_THUMB } from "../../../src/components/scrollbar.js";
import type { TuiHelpContentLine } from "../../../src/state/keymap.js";

const FITTING: readonly TuiHelpContentLine[] = [
  { text: "title", align: "center" },
  { key: "H", description: "help" },
];

const OVERFLOW: readonly TuiHelpContentLine[] = Array.from({ length: 8 }, (_, index) => ({
  key: String(index),
  description: `line ${index}`,
}));

describe("help overlay content", () => {
  it("counts dashboard copy plus keymap lines", () => {
    const empty = helpOverlayContent([]);
    expect(helpOverlayLineCount(0)).toBe(empty.length);
    expect(helpOverlayLineCount(9)).toBe(empty.length + 9);
    expect(helpOverlayContent([{ key: "Ctrl-O", description: "open" }])[1]).toEqual({
      key: "Ctrl-O",
      description: "open",
    });
  });
});

describe("helpPanelLines", () => {
  it("keeps inner padding as spaces when content fits", () => {
    const lines = helpPanelLines(64, 4, FITTING, 0);
    expect(lines[0]?.startsWith("╭")).toBe(true);
    expect(lines[0]?.endsWith("╮")).toBe(true);
    expect(lines.at(-1)?.startsWith("╰")).toBe(true);
    expect(lines.join("")).not.toContain(VERTICAL_SCROLLBAR_THUMB);
    expect(lines[1]?.endsWith("│")).toBe(true);
    expect(lines[1]?.at(-2)).toBe(" ");
  });

  it("windows overflowing copy and paints an inset thumb inside the box", () => {
    const top = helpPanelLines(64, 5, OVERFLOW, 0);
    const scrolled = helpPanelLines(64, 5, OVERFLOW, 2);
    expect(top[1]).toContain("line 0");
    expect(top.join("")).not.toContain("line 5");
    expect(scrolled[1]).toContain("line 2");
    expect(top[1]?.at(-1)).toBe("│");
    expect(top[1]?.at(-2)).toBe(VERTICAL_SCROLLBAR_THUMB);
    expect(top[0]).toMatch(/^╭.+╮$/);
    expect(top.at(-1)).toMatch(/^╰.+╯$/);
  });

  it("clamps a past-the-end offset to the last window", () => {
    const last = helpPanelLines(64, 5, OVERFLOW, 99);
    expect(last[1]).toContain("line 5");
    expect(last[3]).toContain("line 7");
  });
});

describe("helpPanelModel", () => {
  it("splits the inset bar cell for pointer targets", () => {
    const model = helpPanelModel(64, 5, OVERFLOW, 0);
    expect(model.overflow).toBe(true);
    expect(model.bodyRows).toBe(3);
    const body = model.lines[1];
    if (body === undefined || body.kind !== "body") {
      throw new Error("expected a body line");
    }
    expect(joinHelpPanelLine(body)).toHaveLength(64);
    expect(body.bar).toBe(VERTICAL_SCROLLBAR_THUMB);
    expect(body.suffix).toBe("│");
  });
});

describe("clampHelpScrollOffset", () => {
  it("clamps to the last fully visible window", () => {
    expect(clampHelpScrollOffset(22, 18, -3)).toBe(0);
    expect(clampHelpScrollOffset(22, 18, 4)).toBe(4);
    expect(clampHelpScrollOffset(22, 18, 9)).toBe(4);
    expect(helpPanelBodyRows(24, 22)).toBe(18);
  });
});
