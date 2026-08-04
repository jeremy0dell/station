import { describe, expect, it } from "bun:test";
import { getLinkId, rgbToHex } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createOpenTuiSelectionCopyHandler } from "../copy/openTuiSelection.js";
import { semanticCopyContinuationMarker } from "./protocol/semanticCopy.js";
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { nativeStationTheme, stationColorSnapshotValue } from "../theme/index.js";
import { spanAtFrameCell } from "./testing/frameProbe.js";
import { createStationVtScreen, type StationVtScreen } from "./vt/screen.js";
import "./TerminalScreenRenderable.js";

const NATIVE_PAINT = {
  defaultForeground: nativeStationTheme.terminal.defaultForeground.value,
  selectionBackground: stationColorSnapshotValue(nativeStationTheme.pane.selection),
};
const INITIAL_TEST_PAINT = {
  defaultForeground: nativeStationTheme.text.primary.value,
  selectionBackground: nativeStationTheme.interaction.compactFocus.value,
};
const NEXT_TEST_PAINT = {
  defaultForeground: nativeStationTheme.action.success.value,
  selectionBackground: nativeStationTheme.interaction.hover.value,
};

type Paint = {
  defaultForeground: `#${string}`;
  selectionBackground: `#${string}`;
};

function MutablePaintScreen({
  screen,
  initialPaint,
  onSetter,
}: {
  screen: StationVtScreen;
  initialPaint: Paint;
  onSetter(setter: Dispatch<SetStateAction<Paint>>): void;
}) {
  const [paint, setPaint] = useState(initialPaint);
  onSetter(setPaint);
  return (
    <terminalScreen
      screen={screen}
      width="100%"
      height="100%"
      defaultForeground={paint.defaultForeground}
      selectionBackground={paint.selectionBackground}
    />
  );
}

const HARD_BOUNDARY_MARKER = "\x1b]6973;station-copy;1;hard\x1b\\";

async function renderPane(feed: string, width = 20, height = 6) {
  const screen = createStationVtScreen({ size: { cols: width, rows: height } });
  screen.feed(feed);
  await screen.whenIdle();
  const copied: string[] = [];
  const forwarded: string[] = [];
  const setup = await testRender(
    <terminalScreen
      screen={screen}
      width="100%"
      height="100%"
      defaultForeground={NATIVE_PAINT.defaultForeground}
      selectionBackground={NATIVE_PAINT.selectionBackground}
      now={() => 1000}
      onCopySelection={(text: string) => copied.push(text)}
      onForwardInput={(bytes: string) => forwarded.push(bytes)}
    />,
    { width, height },
  );
  await setup.flush();
  return { setup, screen, copied, forwarded };
}

async function teardown(setup: { renderer: { destroy(): void } }, screen: StationVtScreen) {
  setup.renderer.destroy();
  screen.dispose();
}

describe("TerminalScreenRenderable paint props", () => {
  it("redraws default foreground and selection without rebuilding or replacing the screen", async () => {
    const screen = createStationVtScreen({ size: { cols: 20, rows: 6 } });
    screen.feed("paint props");
    await screen.whenIdle();
    let rowBuilds = 0;
    const buildRows = screen.buildRows.bind(screen);
    screen.buildRows = (options) => {
      rowBuilds += 1;
      return buildRows(options);
    };
    const initialPaint: Paint = INITIAL_TEST_PAINT;
    let setPaint: Dispatch<SetStateAction<Paint>> | undefined;
    const setup = await testRender(
      <MutablePaintScreen
        screen={screen}
        initialPaint={initialPaint}
        onSetter={(setter) => {
          setPaint = setter;
        }}
      />,
      { width: 20, height: 6 },
    );
    try {
      await setup.flush();
      await setup.mockMouse.drag(0, 0, 1, 0);
      await setup.renderOnce();
      const before = spanAtFrameCell(setup.captureSpans(), 0, 0);
      expect(before?.fg === undefined ? undefined : rgbToHex(before.fg)).toBe(
        INITIAL_TEST_PAINT.defaultForeground,
      );
      expect(before?.bg === undefined ? undefined : rgbToHex(before.bg)).toBe(
        INITIAL_TEST_PAINT.selectionBackground,
      );
      const engine = screen.unsafeEngine;
      const version = screen.getVersion();
      const buildsBeforeUpdate = rowBuilds;

      await act(async () => {
        setPaint?.(NEXT_TEST_PAINT);
        await Promise.resolve();
      });
      await setup.flush();

      const after = spanAtFrameCell(setup.captureSpans(), 0, 0);
      expect(after?.fg === undefined ? undefined : rgbToHex(after.fg)).toBe(
        NEXT_TEST_PAINT.defaultForeground,
      );
      expect(after?.bg === undefined ? undefined : rgbToHex(after.bg)).toBe(
        NEXT_TEST_PAINT.selectionBackground,
      );
      expect(rowBuilds).toBe(buildsBeforeUpdate);
      expect(screen.getVersion()).toBe(version);
      expect(screen.unsafeEngine).toBe(engine);
    } finally {
      await teardown(setup, screen);
    }
  });
});

describe("TerminalScreenRenderable selection", () => {
  it("retains native hyperlink attributes while highlighting a selection", async () => {
    const uri = "https://example.com/selected";
    const { setup, screen } = await renderPane(`\x1b]8;;${uri}\x1b\\hello\x1b]8;;\x1b\\`);
    try {
      expect(
        getLinkId(setup.renderer.currentRenderBuffer.buffers.attributes[0] ?? 0),
      ).toBeGreaterThan(0);
      await setup.mockMouse.drag(0, 0, 4, 0);
      await setup.renderOnce();
      expect(
        getLinkId(setup.renderer.currentRenderBuffer.buffers.attributes[0] ?? 0),
      ).toBeGreaterThan(0);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("paints selection with the canonical pane role", async () => {
    const { setup, screen } = await renderPane("hello world");
    try {
      await setup.mockMouse.drag(0, 0, 4, 0);
      await setup.renderOnce();
      const selected = spanAtFrameCell(setup.captureSpans(), 0, 0);
      expect(selected?.bg === undefined ? undefined : rgbToHex(selected.bg)).toBe(
        stationColorSnapshotValue(nativeStationTheme.pane.selection),
      );
    } finally {
      await teardown(setup, screen);
    }
  });

  it("preserves selection across terminal projection updates", async () => {
    const { setup, screen } = await renderPane("hello world");
    try {
      await setup.mockMouse.drag(0, 0, 4, 0);
      await setup.renderOnce();
      const versionBeforeUpdate = screen.getVersion();

      screen.updateTerminalTheme(nativeStationTheme.terminal);
      await setup.renderOnce();

      const selected = spanAtFrameCell(setup.captureSpans(), 0, 0);
      expect(selected?.bg === undefined ? undefined : rgbToHex(selected.bg)).toBe(
        stationColorSnapshotValue(nativeStationTheme.pane.selection),
      );
      expect(screen.getVersion()).toBe(versionBeforeUpdate + 1);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("copies the dragged range on release", async () => {
    const { setup, screen, copied } = await renderPane("hello world");
    try {
      await setup.mockMouse.drag(0, 0, 4, 0); // h..o inclusive
      expect(copied).toEqual(["hello"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("drops trailing blank rows when a drag runs past the last output line", async () => {
    const { setup, screen, copied } = await renderPane("hello world");
    try {
      // Drag from the text down into the empty area below it.
      await setup.mockMouse.drag(0, 0, 4, 3);
      expect(copied).toEqual(["hello world"]); // not "hello world\n\n\n"
    } finally {
      await teardown(setup, screen);
    }
  });

  it("does not copy a click with no drag (it deselects)", async () => {
    const { setup, screen, copied } = await renderPane("hello world");
    try {
      await setup.mockMouse.click(2, 0);
      expect(copied).toEqual([]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("expands a double-click to the word and copies it", async () => {
    const { setup, screen, copied } = await renderPane("hello world");
    try {
      await setup.mockMouse.click(2, 0);
      await setup.mockMouse.click(2, 0);
      expect(copied).toEqual(["hello"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("expands a triple-click to the whole line and copies it", async () => {
    const { setup, screen, copied } = await renderPane("hello world");
    try {
      await setup.mockMouse.click(2, 0); // single: deselect
      await setup.mockMouse.click(2, 0); // double: word
      await setup.mockMouse.click(2, 0); // triple: line
      // The double-click copies the word first, then the triple copies the line.
      expect(copied).toEqual(["hello", "hello world"]);
      expect(copied.at(-1)).toBe("hello world");
    } finally {
      await teardown(setup, screen);
    }
  });

  it("still selects on a drag when the app has mouse reporting on", async () => {
    // The chosen tradeoff: clicks forward to the child (e.g. Claude), but a drag
    // stays Station's own selection — even with mouse reporting on.
    const { setup, screen, copied, forwarded } = await renderPane("hello world");
    screen.feed("\x1b[?1000h\x1b[?1006h");
    await screen.whenIdle();
    try {
      await setup.mockMouse.drag(0, 0, 4, 0);
      expect(copied).toEqual(["hello"]);
      expect(forwarded).toEqual([]); // a drag is not forwarded as a click
    } finally {
      await teardown(setup, screen);
    }
  });

  it("rejoins a soft-wrapped logical line without a newline", async () => {
    // 30 chars with no spaces wrap across two 20-col rows; the second row is a
    // wrap continuation, so copy must NOT insert a newline at the boundary.
    const text = "abcdefghijklmnopqrstuvwxyz0123";
    const { setup, screen, copied } = await renderPane(text);
    try {
      await setup.mockMouse.drag(0, 0, 19, 1);
      expect(copied).toEqual([text]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("rejoins a soft-wrap where a wide glyph straddles the boundary without a stray space", async () => {
    // 19 ASCII chars fill cols 0-18; 漢 (width 2) can't fit in the last column, so
    // xterm pads col 19 blank and wraps 漢字 to row 1. Copy must drop that pad, not
    // paste "…s 漢字". (Width 20 pane from renderPane.)
    const text = "abcdefghijklmnopqrs漢字";
    const { setup, screen, copied } = await renderPane(text);
    try {
      await setup.mockMouse.drag(0, 0, 19, 1);
      expect(copied).toEqual([text]); // no space between "s" and "漢"
    } finally {
      await teardown(setup, screen);
    }
  });

  it("rejoins an application-painted continuation and restores consumed spaces", async () => {
    const marker = semanticCopyContinuationMarker(3);
    const { setup, screen, copied } = await renderPane(`echo one   \r\n│ ${marker}two`);
    try {
      await setup.mockMouse.drag(0, 0, 19, 1);
      expect(copied).toEqual(["echo one   two"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("keeps wide glyphs, ANSI, and hyperlinks out of application-wrap metadata", async () => {
    const marker = semanticCopyContinuationMarker(0);
    const first = "abcdefghijklmnopqr漢";
    const uri = "https://example.com/semantic-copy";
    const feed =
      `\x1b[31m${first}\x1b[0m\r\n│ ${marker}` +
      `\x1b]8;;${uri}\x1b\\\x1b[1m字\x1b[0m\x1b]8;;\x1b\\`;
    const { setup, screen, copied } = await renderPane(feed);
    try {
      await setup.mockMouse.drag(0, 0, 19, 1);
      expect(copied).toEqual([`${first}字`]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("keeps unmarked application rows as hard lines", async () => {
    const { setup, screen, copied } = await renderPane("echo one\r\n│ two");
    try {
      await setup.mockMouse.drag(0, 0, 19, 1);
      expect(copied).toEqual(["echo one\n│ two"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("joins long-token continuations without inserting a separator", async () => {
    const marker = semanticCopyContinuationMarker(0);
    const { setup, screen, copied } = await renderPane(`abcdefghijkl\r\n> ${marker}mnop`);
    try {
      await setup.mockMouse.drag(0, 0, 19, 1);
      expect(copied).toEqual(["abcdefghijklmnop"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("omits the visible prefix when selection starts on a continuation row", async () => {
    const marker = semanticCopyContinuationMarker(1);
    const { setup, screen, copied } = await renderPane(`first\r\n│ ${marker}second`);
    try {
      await setup.mockMouse.drag(0, 1, 19, 1);
      expect(copied).toEqual(["second"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("joins through the selected prefix of a final continuation row", async () => {
    const marker = semanticCopyContinuationMarker(1);
    const { setup, screen, copied } = await renderPane(`first\r\n│ ${marker}second tail`);
    try {
      await setup.mockMouse.drag(0, 0, 7, 1);
      expect(copied).toEqual(["first second"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("reconstructs chained application continuations", async () => {
    const { setup, screen, copied } = await renderPane(
      `one  \r\n│ ${semanticCopyContinuationMarker(2)}two \r\n│ ${semanticCopyContinuationMarker(1)}three`,
    );
    try {
      await setup.mockMouse.drag(0, 0, 19, 2);
      expect(copied).toEqual(["one  two three"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("removes hard-row gutters while preserving intentional newlines", async () => {
    const content = HARD_BOUNDARY_MARKER;
    const { setup, screen, copied } = await renderPane(
      `  ${content}echo one\r\n  ${content}echo two`,
    );
    try {
      await setup.mockMouse.drag(0, 0, 19, 1);
      expect(copied).toEqual(["echo one\necho two"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("copies quoted and unquoted shell text exactly across multiple application wraps", async () => {
    const content = HARD_BOUNDARY_MARKER;
    const continuation = semanticCopyContinuationMarker(1);
    const expected = "printf 'quick brown fox'; uname -s";
    const { setup, screen, copied } = await renderPane(
      `  ${content}printf 'quick\r\n  ${continuation}brown fox'; uname\r\n  ${continuation}-s`,
    );
    try {
      await setup.mockMouse.drag(0, 0, 19, 2);
      expect(copied).toEqual([expected]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("preserves Unicode graphemes across marked application wraps", async () => {
    const content = HARD_BOUNDARY_MARKER;
    const continuation = semanticCopyContinuationMarker(1);
    const expected = "café naïve résumé 中文 é 😀 end";
    const { setup, screen, copied } = await renderPane(
      `  ${content}café naïve\r\n│ ${continuation}résumé 中文\r\n│ ${continuation}é 😀 end`,
    );
    try {
      await setup.mockMouse.drag(0, 0, 19, 2);
      expect(copied).toEqual([expected]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("produces width-independent clipboard text from marked renderer layouts", async () => {
    const content = HARD_BOUNDARY_MARKER;
    const continuation = semanticCopyContinuationMarker(1);
    const expected = "echo alpha beta gamma";
    const wide = await renderPane(`  ${content}${expected}`, 40, 3);
    const narrow = await renderPane(
      `  ${content}echo alpha\r\n  ${continuation}beta gamma`,
      14,
      3,
    );
    try {
      await wide.setup.mockMouse.drag(0, 0, 39, 0);
      await narrow.setup.mockMouse.drag(0, 0, 13, 1);
      expect(wide.copied).toEqual([expected]);
      expect(narrow.copied).toEqual([expected]);
    } finally {
      await teardown(wide.setup, wide.screen);
      await teardown(narrow.setup, narrow.screen);
    }
  });

  it("copies terminal selection on drag release and lets OpenTUI Ctrl-C fall through", async () => {
    const content = HARD_BOUNDARY_MARKER;
    const continuation = semanticCopyContinuationMarker(1);
    const expected = "alpha beta";
    const { setup, screen, copied } = await renderPane(
      `  ${content}alpha\r\n  ${continuation}beta`,
    );
    const keyboardCopies: string[] = [];
    const handleCopy = createOpenTuiSelectionCopyHandler(() => setup.renderer, {
      setInternal: (text) => keyboardCopies.push(text),
      writeOsc52: (text) => keyboardCopies.push(text),
      copyToPlatform: (text) => keyboardCopies.push(text),
      isRemoteSession: () => false,
    });
    try {
      await setup.mockMouse.drag(0, 0, 19, 1);
      expect(copied).toEqual([expected]);
      expect(handleCopy("\x03")).toBe(false);
      expect(keyboardCopies).toEqual([]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("double-clicks the correct word on a line with wide (CJK) characters", async () => {
    // 漢 and 字 are each two cells but one code point; without cell↔char mapping
    // the click column would land in the wrong place.
    const { setup, screen, copied } = await renderPane("漢字 hello");
    try {
      await setup.mockMouse.click(2, 0); // cell 2 = second wide char (字)
      await setup.mockMouse.click(2, 0);
      expect(copied).toEqual(["漢字"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("double-clicks the right word when the click lands on a wide glyph's 2nd cell", async () => {
    // Cell 1 is the continuation half of 漢; it must map to 漢, not the next char.
    const { setup, screen, copied } = await renderPane("漢字 hello");
    try {
      await setup.mockMouse.click(1, 0);
      await setup.mockMouse.click(1, 0);
      expect(copied).toEqual(["漢字"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("selects even in an alt-screen app", async () => {
    // The alternate screen is a fresh buffer, so paint content into it (as a
    // pager/TUI would) before selecting.
    const { setup, screen, copied } = await renderPane("");
    screen.feed("\x1b[?1049h"); // enter the alternate screen (less/vim/a TUI)
    screen.feed("hello world");
    await screen.whenIdle();
    try {
      await setup.mockMouse.drag(0, 0, 4, 0);
      expect(copied).toEqual(["hello"]);
    } finally {
      await teardown(setup, screen);
    }
  });
});

describe("TerminalScreenRenderable mouse forwarding", () => {
  it("forwards a click as an SGR press+release when the app has mouse reporting on", async () => {
    const { setup, screen, copied, forwarded } = await renderPane("hello world");
    screen.feed("\x1b[?1000h\x1b[?1006h"); // vt200 tracking + SGR encoding
    await screen.whenIdle();
    try {
      await setup.mockMouse.click(2, 0); // 0-based cell -> 1-based col 3, row 1
      expect(forwarded).toEqual(["\x1b[<0;3;1M", "\x1b[<0;3;1m"]);
      expect(copied).toEqual([]); // a forwarded click never copies
    } finally {
      await teardown(setup, screen);
    }
  });

  it("does not forward a click when the app has no mouse reporting", async () => {
    const { setup, screen, forwarded } = await renderPane("hello world");
    try {
      await setup.mockMouse.click(2, 0);
      expect(forwarded).toEqual([]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("forwards hover motion when the app requests any-event tracking (1003)", async () => {
    const { setup, screen, forwarded } = await renderPane("hello world");
    screen.feed("\x1b[?1003h\x1b[?1006h"); // any-event tracking + SGR
    await screen.whenIdle();
    try {
      await setup.mockMouse.moveTo(4, 1); // -> col 5, row 2; buttonless motion
      expect(forwarded).toContain("\x1b[<35;5;2M");
    } finally {
      await teardown(setup, screen);
    }
  });

  it("does not forward hover when only button-event tracking (1002) is on", async () => {
    const { setup, screen, forwarded } = await renderPane("hello world");
    screen.feed("\x1b[?1002h\x1b[?1006h"); // drag tracking: no bare-motion reports
    await screen.whenIdle();
    try {
      await setup.mockMouse.moveTo(4, 1);
      expect(forwarded).toEqual([]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("forwards a Shift-free click but never a Shift-click (reserved for native selection)", async () => {
    const { setup, screen, forwarded } = await renderPane("hello world");
    screen.feed("\x1b[?1000h\x1b[?1006h");
    await screen.whenIdle();
    try {
      await setup.mockMouse.click(2, 0, 0, { modifiers: { shift: true } });
      expect(forwarded).toEqual([]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("does not forward a right-click (Station keeps it for the context menu)", async () => {
    const { setup, screen, forwarded } = await renderPane("hello world");
    screen.feed("\x1b[?1000h\x1b[?1006h");
    await screen.whenIdle();
    try {
      await setup.mockMouse.click(2, 0, 2); // button 2 = right
      expect(forwarded).toEqual([]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("forwards a middle-click press+release to the app", async () => {
    const { setup, screen, forwarded } = await renderPane("hello world");
    screen.feed("\x1b[?1000h\x1b[?1006h");
    await screen.whenIdle();
    try {
      await setup.mockMouse.click(2, 0, 1); // button 1 = middle -> SGR button code 1
      expect(forwarded).toEqual(["\x1b[<1;3;1M", "\x1b[<1;3;1m"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("still owes the middle-click release after intervening output resets selection", async () => {
    // The middle press is forwarded on `down`; its release is owed via #middleDown,
    // which must survive the output-driven #resetSelection (anchor is null for a
    // middle press). Without that, the release would be dropped.
    const { setup, screen, forwarded } = await renderPane("hello world");
    screen.feed("\x1b[?1000h\x1b[?1006h");
    await screen.whenIdle();
    try {
      await setup.mockMouse.pressDown(2, 0, 1); // middle press forwarded now
      screen.feed("x"); // output -> screen update -> #resetSelection
      await screen.whenIdle();
      await new Promise((resolve) => setTimeout(resolve, 60)); // let the flush fire the subscriber
      await setup.mockMouse.release(2, 0, 1);
      expect(forwarded).toEqual(["\x1b[<1;3;1M", "\x1b[<1;3;1m"]);
    } finally {
      await teardown(setup, screen);
    }
  });

  it("forwards X10 (DECSET 9) tracking as a press with no release", async () => {
    const { setup, screen, forwarded } = await renderPane("hello world");
    screen.feed("\x1b[?9h"); // X10 tracking, no SGR -> legacy byte encoding
    await screen.whenIdle();
    try {
      await setup.mockMouse.click(2, 0); // col 3, row 1 -> 0+32, 3+32, 1+32
      expect(forwarded).toEqual(["\x1b[M\x20\x23\x21"]); // press only, no release
    } finally {
      await teardown(setup, screen);
    }
  });
});
