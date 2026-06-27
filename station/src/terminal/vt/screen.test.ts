import { afterEach, describe, expect, it } from "bun:test";
import { waitFor } from "../testing/waitFor.js";
import { createStationVtScreen, type StationVtScreen } from "./screen.js";

describe("createStationVtScreen", () => {
  const cleanups: Array<() => void> = [];
  const track = (screen: StationVtScreen): StationVtScreen => {
    cleanups.push(() => {
      screen.dispose();
    });
    return screen;
  };
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("bumps the version after a write settles", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    expect(screen.getVersion()).toBe(0);
    screen.feed("hello");
    await waitFor(() => screen.getVersion() >= 1);
  });

  it("coalesces rapid chunks instead of bumping per chunk", async () => {
    const screen = track(
      createStationVtScreen({ size: { cols: 20, rows: 5 }, flushIntervalMs: 150 }),
    );
    for (let index = 0; index < 50; index++) {
      screen.feed(`chunk-${index}\r\n`);
    }
    await screen.whenIdle();
    await waitFor(() => screen.getVersion() >= 1);
    // Leading flush + at most one trailing flush (plus tolerance), never 50.
    expect(screen.getVersion()).toBeLessThanOrEqual(3);
  });

  it("notifies subscribers on flush and stops after unsubscribe", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    let notified = 0;
    const unsubscribe = screen.subscribe(() => {
      notified += 1;
    });
    screen.feed("a");
    await waitFor(() => notified > 0);

    unsubscribe();
    const seen = notified;
    screen.feed("b");
    await screen.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notified).toBe(seen);
  });

  it("tracks cursor visibility through dectcem", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    expect(screen.isCursorVisible()).toBe(true);
    screen.feed("\x1b[?25l");
    await screen.whenIdle();
    expect(screen.isCursorVisible()).toBe(false);
    screen.feed("\x1b[?25h");
    await screen.whenIdle();
    expect(screen.isCursorVisible()).toBe(true);
    // Param lists containing 25 count too.
    screen.feed("\x1b[?2004;25l");
    await screen.whenIdle();
    expect(screen.isCursorVisible()).toBe(false);
  });

  it("ris restores cursor visibility", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    screen.feed("\x1b[?25l");
    await screen.whenIdle();
    expect(screen.isCursorVisible()).toBe(false);
    screen.feed("\x1bc");
    await screen.whenIdle();
    expect(screen.isCursorVisible()).toBe(true);
  });

  it("resize changes the grid and bumps the version", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    screen.resize({ cols: 100, rows: 40 });
    expect(screen.bufferStats().cols).toBe(100);
    expect(screen.bufferStats().rows).toBe(40);
    await waitFor(() => screen.getVersion() >= 1);
  });

  it("clamps degenerate resizes instead of throwing", () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    screen.resize({ cols: 0, rows: 0 });
    expect(screen.bufferStats().cols).toBe(2);
    expect(screen.bufferStats().rows).toBe(1);
  });

  it("dispose is idempotent and silences feed, resize, and subscribers", async () => {
    const screen = createStationVtScreen({ size: { cols: 20, rows: 5 } });
    let notified = 0;
    screen.subscribe(() => {
      notified += 1;
    });
    screen.dispose();
    screen.dispose();
    screen.feed("after dispose");
    screen.resize({ cols: 30, rows: 10 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notified).toBe(0);
  });

  it("answers da1 through the response callback", async () => {
    const responses: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: { cols: 20, rows: 5 },
        onResponse: (data) => {
          responses.push(data);
        },
      }),
    );
    screen.feed("\x1b[c");
    await waitFor(() => responses.join("").includes("\x1b[?1;2c"));
  });

  it("reports cursor position for dsr 6", async () => {
    const responses: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: { cols: 20, rows: 5 },
        onResponse: (data) => {
          responses.push(data);
        },
      }),
    );
    screen.feed("ab\x1b[6n");
    await waitFor(() => /\x1b\[1;3R/.test(responses.join("")));
  });

  // Executable proof of the headless gap: xterm's browser ThemeService is the
  // only OSC color responder upstream, so the store must answer itself.
  it("answers osc 10/11 color queries with theme colors", async () => {
    const responses: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: { cols: 20, rows: 5 },
        theme: {
          foreground: "#d4d4d8",
          background: "#101316",
          ansi16: Array.from({ length: 16 }, () => "#000000"),
        },
        onResponse: (data) => {
          responses.push(data);
        },
      }),
    );
    screen.feed("\x1b]10;?\x07\x1b]11;?\x07");
    await waitFor(() => responses.join("").includes("]10;rgb:d4d4/d4d4/d8d8"));
    await waitFor(() => responses.join("").includes("]11;rgb:1010/1313/1616"));
  });

  it("does not intercept osc color set operations", async () => {
    const responses: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: { cols: 20, rows: 5 },
        onResponse: (data) => {
          responses.push(data);
        },
      }),
    );
    screen.feed("\x1b]10;#ff0000\x07");
    await screen.whenIdle();
    expect(responses.join("")).not.toContain("]10;rgb:");
  });

  // Feed text and wait until the coalesced flush that processes it has run, so
  // the scroll-on-output bookkeeping (which lives in flush) is deterministic.
  const feedAndFlush = async (screen: StationVtScreen, text: string): Promise<void> => {
    const before = screen.getVersion();
    screen.feed(text);
    await screen.whenIdle();
    await waitFor(() => screen.getVersion() > before);
  };
  const topRow = (screen: StationVtScreen): string =>
    (screen.buildRows({ cursorVisible: false })[0]?.spans ?? [])
      .map((span) => span.text)
      .join("");
  // 10 single-line rows in a 4-row viewport → 6 lines of scrollback (baseY 6).
  const tenLines = Array.from({ length: 10 }, (_, index) => `L${index}`).join("\r\n");

  it("scrolls scrollback up and clamps at the oldest line", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 4 } }));
    await feedAndFlush(screen, tenLines);
    expect(screen.getScrollOffset()).toBe(0);
    expect(topRow(screen)).toBe("L6");

    expect(screen.scrollBy(3)).toBe(true);
    expect(screen.getScrollOffset()).toBe(3);
    expect(topRow(screen)).toBe("L3");

    expect(screen.scrollBy(100)).toBe(true);
    expect(screen.getScrollOffset()).toBe(6);
    expect(topRow(screen)).toBe("L0");
    // Already at the oldest line: no further movement.
    expect(screen.scrollBy(5)).toBe(false);
  });

  it("scrollToBottom returns to the live view", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 4 } }));
    await feedAndFlush(screen, tenLines);
    screen.scrollBy(4);
    expect(screen.scrollToBottom()).toBe(true);
    expect(screen.getScrollOffset()).toBe(0);
    expect(screen.scrollToBottom()).toBe(false);
  });

  it("freeze holds the scrolled-to lines as new output arrives", async () => {
    const screen = track(
      createStationVtScreen({ size: { cols: 20, rows: 4 }, scrollOnOutput: "freeze" }),
    );
    await feedAndFlush(screen, tenLines);
    screen.scrollBy(3);
    expect(topRow(screen)).toBe("L3");
    await feedAndFlush(screen, "\r\nL10\r\nL11");
    expect(screen.getScrollOffset()).toBe(5);
    expect(topRow(screen)).toBe("L3");
  });

  it("freeze holds position even when scrollback is at its cap", async () => {
    // scrollback 3 + rows 2 => the buffer saturates at 5 lines, after which
    // baseY plateaus while old lines keep evicting (the deltaBase model failed
    // here; the marker still tracks the held line).
    const screen = track(
      createStationVtScreen({
        size: { cols: 20, rows: 2 },
        scrollback: 3,
        scrollOnOutput: "freeze",
      }),
    );
    await feedAndFlush(screen, ["L0", "L1", "L2", "L3", "L4"].join("\r\n"));
    screen.scrollBy(1);
    expect(topRow(screen)).toBe("L2");
    // Evicts L0; baseY stays capped, so a deltaBase-based freeze would slip to L3.
    await feedAndFlush(screen, "\r\nL5");
    expect(topRow(screen)).toBe("L2");
    expect(screen.getScrollOffset()).toBe(2);
  });

  it("follow snaps back to the bottom on new output", async () => {
    const screen = track(
      createStationVtScreen({ size: { cols: 20, rows: 4 }, scrollOnOutput: "follow" }),
    );
    await feedAndFlush(screen, tenLines);
    screen.scrollBy(3);
    await feedAndFlush(screen, "\r\nL10\r\nL11");
    expect(screen.getScrollOffset()).toBe(0);
    expect(topRow(screen)).toBe("L8");
  });

  it("shift keeps the offset constant so the view slides with output", async () => {
    const screen = track(
      createStationVtScreen({ size: { cols: 20, rows: 4 }, scrollOnOutput: "shift" }),
    );
    await feedAndFlush(screen, tenLines);
    screen.scrollBy(3);
    expect(topRow(screen)).toBe("L3");
    await feedAndFlush(screen, "\r\nL10\r\nL11");
    expect(screen.getScrollOffset()).toBe(3);
    expect(topRow(screen)).toBe("L5");
  });

  it("reports mouse tracking and application cursor key modes", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    expect(screen.isMouseReportingEnabled()).toBe(false);
    expect(screen.isApplicationCursorKeys()).toBe(false);

    screen.feed("\x1b[?1000h\x1b[?1h");
    await screen.whenIdle();
    expect(screen.isMouseReportingEnabled()).toBe(true);
    expect(screen.isApplicationCursorKeys()).toBe(true);

    screen.feed("\x1b[?1000l\x1b[?1l");
    await screen.whenIdle();
    expect(screen.isMouseReportingEnabled()).toBe(false);
    expect(screen.isApplicationCursorKeys()).toBe(false);
  });

  it("reports the mouse protocol flavor and SGR encoding for forwarding", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    expect(screen.mouseProtocol()).toBeNull();

    screen.feed("\x1b[?1002h\x1b[?1006h"); // button-event tracking + SGR
    await screen.whenIdle();
    expect(screen.mouseProtocol()).toEqual({ tracking: "drag", encoding: "sgr" });

    screen.feed("\x1b[?1003h"); // promote to any-event tracking
    await screen.whenIdle();
    expect(screen.mouseProtocol()).toEqual({ tracking: "any", encoding: "sgr" });

    screen.feed("\x1b[?1006l"); // drop SGR -> legacy byte encoding
    await screen.whenIdle();
    expect(screen.mouseProtocol()).toEqual({ tracking: "any", encoding: "x10" });

    screen.feed("\x1bc"); // RIS clears tracking and the SGR bit
    await screen.whenIdle();
    expect(screen.mouseProtocol()).toBeNull();
  });

  it("maps x10 press-only tracking (DECSET 9) with default legacy encoding", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    screen.feed("\x1b[?9h"); // X10 mouse: the press-only flavor with no SGR negotiated
    await screen.whenIdle();
    expect(screen.mouseProtocol()).toEqual({ tracking: "x10", encoding: "x10" });
  });

  it("tracks and answers kitty keyboard protocol state", async () => {
    const responses: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: { cols: 20, rows: 5 },
        onResponse: (data) => {
          responses.push(data);
        },
      }),
    );
    expect(screen.isKittyKeyboardEnabled()).toBe(false);

    screen.feed("\x1b[>1u\x1b[?u");
    await screen.whenIdle();
    expect(screen.isKittyKeyboardEnabled()).toBe(true);
    expect(responses.join("")).toContain("\x1b[?1u");

    screen.feed("\x1b[=0u");
    await screen.whenIdle();
    expect(screen.isKittyKeyboardEnabled()).toBe(false);

    screen.feed("\x1b[=2u\x1b[>4u\x1b[<u");
    await screen.whenIdle();
    expect(screen.isKittyKeyboardEnabled()).toBe(true);
  });

  it("flags soft-wrap continuation rows", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 6 } }));
    screen.feed("abcdefghijklmnopqrstuvwxyz0123"); // 30 chars -> wraps at col 20
    await screen.whenIdle();
    expect(screen.isViewRowWrapped(0)).toBe(false);
    expect(screen.isViewRowWrapped(1)).toBe(true);
  });

  it("maps char indices to cell columns across wide chars", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 4 } }));
    screen.feed("漢字 hi"); // 漢:cells 0-1, 字:cells 2-3, space:cell 4, h:cell 5, i:cell 6
    await screen.whenIdle();
    expect(screen.cellColumnForCharIndex(0, 0)).toBe(0);
    expect(screen.cellColumnForCharIndex(0, 1)).toBe(2);
    expect(screen.cellColumnForCharIndex(0, 2)).toBe(4);
    expect(screen.cellColumnForCharIndex(0, 3)).toBe(5);
  });
});
