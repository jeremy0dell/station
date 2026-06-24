import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createStationVtScreen, type StationVtScreen } from "./vt/screen.js";
import "./TerminalScreenRenderable.js";

async function renderPane(feed: string) {
  const screen = createStationVtScreen({ size: { cols: 20, rows: 6 } });
  screen.feed(feed);
  await screen.whenIdle();
  const copied: string[] = [];
  const forwarded: string[] = [];
  const setup = await testRender(
    <terminalScreen
      screen={screen}
      width="100%"
      height="100%"
      now={() => 1000}
      onCopySelection={(text: string) => copied.push(text)}
      onForwardInput={(bytes: string) => forwarded.push(bytes)}
    />,
    { width: 20, height: 6 },
  );
  await setup.flush();
  return { setup, screen, copied, forwarded };
}

async function teardown(setup: { renderer: { destroy(): void } }, screen: StationVtScreen) {
  setup.renderer.destroy();
  screen.dispose();
}

describe("TerminalScreenRenderable selection", () => {
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
