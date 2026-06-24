import { describe, expect, it } from "bun:test";
import { assertVtCase } from "../testing/vtAssert.js";
import { allVtCases } from "./cases/index.js";
import { createStationVtScreen } from "./screen.js";

const DEFAULT_CASE_SIZE = { cols: 20, rows: 6 };

describe("vt conformance", () => {
  for (const vtCase of allVtCases) {
    it(vtCase.name, async () => {
      const screen = createStationVtScreen({
        size: vtCase.size ?? DEFAULT_CASE_SIZE,
        ...(vtCase.scrollback === undefined ? {} : { scrollback: vtCase.scrollback }),
      });
      try {
        await assertVtCase(screen, vtCase);
      } finally {
        screen.dispose();
      }
    });
  }

  it("scrolled-off content stays retrievable from the scrollback buffer", async () => {
    const screen = createStationVtScreen({ size: { cols: 20, rows: 4 }, scrollback: 100 });
    try {
      screen.feed(Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\r\n"));
      await screen.whenIdle();
      const buffer = screen.unsafeEngine.buffer.active;
      expect(buffer.getLine(0)?.translateToString(true)).toBe("line-0");
    } finally {
      screen.dispose();
    }
  });
});
