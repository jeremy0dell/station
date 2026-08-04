import { afterEach, describe, expect, it } from "bun:test";
import {
  nativeStationTheme,
  rgbColor,
  type StationTerminalTheme,
} from "../../theme/index.js";
import { DecMode } from "../protocol/decset.js";
import { CsiCommand } from "../protocol/identifiers.js";
import { KittyFlagUpdateMode, KittySequence } from "../protocol/kitty.js";
import { VtPrefix } from "../protocol/syntax.js";
import { waitFor } from "../testing/waitFor.js";
import type { VtRow } from "./rows.js";
import { createStationVtScreen, type StationVtScreen } from "./screen.js";

function terminalTheme(
  defaultForeground: `#${string}`,
  defaultBackground: `#${string}`,
  ansiBlack: `#${string}`,
  ansiRed: `#${string}`,
): StationTerminalTheme {
  const [, , ...ansiTail] = nativeStationTheme.terminal.ansi16;
  return {
    defaultForeground: rgbColor(defaultForeground),
    defaultBackground: rgbColor(defaultBackground),
    ansi16: [rgbColor(ansiBlack), rgbColor(ansiRed), ...ansiTail],
  };
}

function foregroundForText(rows: readonly VtRow[], text: string): string | undefined {
  return rows.flatMap((row) => row.spans).find((span) => span.text.includes(text))?.fg;
}

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

  it("ris clears the title and notifies title subscribers", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    const titles: Array<string | undefined> = [];
    screen.onTitleChange(() => {
      titles.push(screen.getTitle());
    });

    screen.feed("\x1b]2;working\x07");
    await screen.whenIdle();
    screen.feed("\x1bc");
    await screen.whenIdle();

    expect(screen.getTitle()).toBeUndefined();
    expect(titles).toEqual(["working", undefined]);
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

  it("builds ANSI-256 colors from the selected terminal theme", async () => {
    const [, ...ansiTail] = nativeStationTheme.terminal.ansi16;
    const screen = track(
      createStationVtScreen({
        size: { cols: 20, rows: 5 },
        theme: {
          ...nativeStationTheme.terminal,
          ansi16: [rgbColor("#010203"), ...ansiTail],
        },
      }),
    );
    screen.feed("\x1b[30mX");
    await screen.whenIdle();
    expect(screen.buildRows({ cursorVisible: false })[0]?.spans[0]?.fg).toBe("#010203");
  });

  it("updates terminal color projection without mutating the parsed screen", async () => {
    const initialTheme = terminalTheme("#101112", "#131415", "#161718", "#192021");
    const nextTheme = terminalTheme("#a0a1a2", "#a3a4a5", "#a6a7a8", "#a9aaab");
    const responses: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: { cols: 40, rows: 3 },
        theme: initialTheme,
        onResponse: (data) => responses.push(data),
      }),
    );
    screen.feed(
      "D\x1b[31mI\x1b[38;5;196mF\x1b[38;2;1;2;3mT\x1b[0m" +
        "\x1b]8;;https://example.com/theme\x1b\\L\x1b]8;;\x1b\\" +
        "\r\none\r\ntwo\r\nthree" +
        "\x1b]2;theme-proof\x07\x1b[?2004h\x1b[?1000h\x1b[?1h\x1b[=1u" +
        "\x1b]10;?\x07\x1b]11;?\x07",
    );
    await screen.whenIdle();
    await waitFor(() => screen.getVersion() > 0);
    screen.scrollBy(1);

    expect(responses).toEqual([
      "\x1b]10;rgb:1010/1111/1212\x07",
      "\x1b]11;rgb:1313/1414/1515\x07",
    ]);
    const beforeRows = screen.buildRows({ cursorVisible: false });
    expect(foregroundForText(beforeRows, "D")).toBeUndefined();
    expect(foregroundForText(beforeRows, "I")).toBe("#192021");
    expect(foregroundForText(beforeRows, "F")).toBe("#ff0000");
    expect(foregroundForText(beforeRows, "T")).toBe("#010203");

    const buffer = screen.unsafeEngine.buffer.active;
    const parsedState = {
      bufferContents: Array.from({ length: buffer.length }, (_, index) =>
        buffer.getLine(index)?.translateToString(false),
      ),
      visibleText: Array.from({ length: screen.bufferStats().rows }, (_, index) =>
        screen.viewRowText(index),
      ),
      cursor: screen.cursor(),
      scrollOffset: screen.getScrollOffset(),
      geometry: screen.bufferStats(),
      modes: {
        alt: screen.isAltScreen(),
        applicationCursor: screen.isApplicationCursorKeys(),
        bracketedPaste: screen.isBracketedPasteEnabled(),
        cursorVisible: screen.isCursorVisible(),
        kittyKeyboard: screen.isKittyKeyboardEnabled(),
        mouse: screen.mouseProtocol(),
      },
      links: beforeRows.flatMap((row) => row.spans.map((span) => span.link)),
      title: screen.getTitle(),
    };
    responses.length = 0;
    const invalidations: string[] = [];
    screen.subscribe((invalidation) => {
      invalidations.push(invalidation);
    });
    const versionBeforeUpdate = screen.getVersion();

    screen.updateTerminalTheme(nextTheme);

    expect(screen.getVersion()).toBe(versionBeforeUpdate + 1);
    expect(invalidations).toEqual(["repaint"]);
    expect(responses).toEqual([]);
    const nextRows = screen.buildRows({ cursorVisible: false });
    expect(foregroundForText(nextRows, "D")).toBeUndefined();
    expect(foregroundForText(nextRows, "I")).toBe("#a9aaab");
    expect(foregroundForText(nextRows, "F")).toBe("#ff0000");
    expect(foregroundForText(nextRows, "T")).toBe("#010203");
    expect({
      bufferContents: Array.from({ length: buffer.length }, (_, index) =>
        buffer.getLine(index)?.translateToString(false),
      ),
      visibleText: Array.from({ length: screen.bufferStats().rows }, (_, index) =>
        screen.viewRowText(index),
      ),
      cursor: screen.cursor(),
      scrollOffset: screen.getScrollOffset(),
      geometry: screen.bufferStats(),
      modes: {
        alt: screen.isAltScreen(),
        applicationCursor: screen.isApplicationCursorKeys(),
        bracketedPaste: screen.isBracketedPasteEnabled(),
        cursorVisible: screen.isCursorVisible(),
        kittyKeyboard: screen.isKittyKeyboardEnabled(),
        mouse: screen.mouseProtocol(),
      },
      links: nextRows.flatMap((row) => row.spans.map((span) => span.link)),
      title: screen.getTitle(),
    }).toEqual(parsedState);

    screen.feed("\x1b]10;#ffffff\x07\x1b]11;#000000\x07");
    await screen.whenIdle();
    expect(responses).toEqual([]);
    screen.feed("\x1b]10;?\x07\x1b]11;?\x07");
    await waitFor(() => responses.length === 2);
    expect(responses).toEqual([
      "\x1b]10;rgb:a0a0/a1a1/a2a2\x07",
      "\x1b]11;rgb:a3a3/a4a4/a5a5\x07",
    ]);
  });

  // Executable proof of the headless gap: xterm's browser ThemeService is the
  // only OSC color responder upstream, so the store must answer itself.
  it("answers osc 10/11 color queries with theme colors", async () => {
    const responses: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: { cols: 20, rows: 5 },
        theme: {
          ...nativeStationTheme.terminal,
          defaultForeground: rgbColor("#010203"),
          defaultBackground: rgbColor("#040506"),
        },
        onResponse: (data) => {
          responses.push(data);
        },
      }),
    );
    screen.feed("\x1b]10;?\x07\x1b]11;?\x07");
    await waitFor(() => responses.join("").includes("]10;rgb:0101/0202/0303"));
    await waitFor(() => responses.join("").includes("]11;rgb:0404/0505/0606"));
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
  const rowLinks = (screen: StationVtScreen, row = 0): string[] =>
    (screen.buildRows({ cursorVisible: false })[row]?.spans ?? [])
      .map((span) => span.link)
      .filter((link): link is string => link !== undefined);

  it("parses OSC 8 opens and closes split across feed chunks", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 4 } }));
    screen.feed("\x1b]8;;https://example.com/chunk");
    screen.feed("-split\x1b\\linked");
    screen.feed("\x1b]8;;");
    screen.feed("\x1b\\ plain");
    await screen.whenIdle();

    const spans = screen.buildRows({ cursorVisible: false })[0]?.spans ?? [];
    expect(spans.map(({ text, link }) => ({ text, link }))).toEqual([
      { text: "linked", link: "https://example.com/chunk-split" },
      { text: " plain", link: undefined },
    ]);
  });

  it("lets overwrite, erase, and RIS remove xterm-owned link metadata", async () => {
    const uri = "https://example.com/lifecycle";
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 4 } }));
    await feedAndFlush(screen, `\x1b]8;;${uri}\x1b\\ABC\x1b]8;;\x1b\\`);

    await feedAndFlush(screen, "\r\x1b[1CX");
    const overwritten = screen.buildRows({ cursorVisible: false })[0]?.spans ?? [];
    expect(overwritten.map(({ text, link }) => ({ text, link }))).toEqual([
      { text: "A", link: uri },
      { text: "X", link: undefined },
      { text: "C", link: uri },
    ]);

    await feedAndFlush(screen, "\r\x1b[2K");
    expect(rowLinks(screen)).toEqual([]);

    await feedAndFlush(screen, `\x1b]8;;${uri}\x1b\\Z\x1b]8;;\x1b\\\x1bc`);
    expect(screen.buildRows({ cursorVisible: false }).flatMap((row) => row.spans)).toEqual([]);
  });

  it("keeps normal and alternate-buffer links isolated", async () => {
    const normalUri = "https://example.com/normal";
    const alternateUri = "file:///tmp/alternate";
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 4 } }));
    await feedAndFlush(screen, `\x1b]8;;${normalUri}\x1b\\normal\x1b]8;;\x1b\\`);

    await feedAndFlush(
      screen,
      `\x1b[?1049h\x1b]8;;${alternateUri}\x1b\\alternate\x1b]8;;\x1b\\`,
    );
    expect(rowLinks(screen)).toEqual([alternateUri]);

    await feedAndFlush(screen, "\x1b[?1049l");
    expect(rowLinks(screen)).toEqual([normalUri]);
  });

  it("preserves link ownership through resize reflow and retained scrollback", async () => {
    const uri = "custom:reflow";
    const screen = track(
      createStationVtScreen({ size: { cols: 6, rows: 2 }, scrollback: 4 }),
    );
    await feedAndFlush(screen, `\x1b]8;;${uri}\x1b\\abcdefghij\x1b]8;;\x1b\\`);
    screen.resize({ cols: 4, rows: 3 });
    await screen.whenIdle();
    expect(
      screen
        .buildRows({ cursorVisible: false })
        .flatMap((row) => row.spans)
        .filter((span) => span.text.trim().length > 0)
        .every((span) => span.link === uri),
    ).toBe(true);

    await feedAndFlush(
      screen,
      Array.from(
        { length: 12 },
        (_, index) => `\r\n\x1b]8;;https://example.com/${index}\x1b\\L${index}\x1b]8;;\x1b\\`,
      ).join(""),
    );
    screen.scrollBy(99);
    const retained = screen.buildRows({ cursorVisible: false }).flatMap((row) => row.spans);
    expect(retained.some((span) => span.link !== undefined)).toBe(true);
    expect(retained.every((span) => span.link !== "https://example.com/0")).toBe(true);
  });

  it("resolves repeated OSC ids by both id and URI without bleeding", async () => {
    const first = "https://example.com/reused";
    const second = "mailto:changed@example.com";
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 4 } }));
    await feedAndFlush(
      screen,
      `\x1b]8;id=same;${first}\x1b\\A\x1b]8;;\x1b\\` +
        `\x1b]8;id=same;${first}\x1b\\B\x1b]8;;\x1b\\` +
        `\x1b]8;id=same;${second}\x1b\\C\x1b]8;;\x1b\\`,
    );
    const spans = screen.buildRows({ cursorVisible: false })[0]?.spans ?? [];
    expect(spans.map(({ text, link }) => ({ text, link }))).toEqual([
      { text: "AB", link: first },
      { text: "C", link: second },
    ]);
  });

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

    responses.length = 0;
    screen.feed("\x1b[=2u\x1b[>5u\x1bc\x1b[?u\x1b[<u\x1b[?u");
    await screen.whenIdle();
    expect(screen.isKittyKeyboardEnabled()).toBe(false);
    expect(responses).toEqual(["\x1b[?0u", "\x1b[?0u"]);
  });

  it("applies generated Kitty commands independently in each buffer", async () => {
    const responses: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: { cols: 20, rows: 5 },
        onResponse: (data) => responses.push(data),
      }),
    );

    screen.feed(
      `${VtPrefix.Csi}${CsiCommand.KittyUpdateFlags.prefix}1${CsiCommand.KittyUpdateFlags.final}` +
        `${VtPrefix.Csi}${CsiCommand.KittyUpdateFlags.prefix}2;${KittyFlagUpdateMode.SetBits}${CsiCommand.KittyUpdateFlags.final}` +
        `${VtPrefix.Csi}${CsiCommand.KittyUpdateFlags.prefix}1;${KittyFlagUpdateMode.ClearBits}${CsiCommand.KittyUpdateFlags.final}` +
        KittySequence.QueryFlags +
        `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.SaveCursorAndAlternate}${CsiCommand.SetDecPrivateMode.final}` +
        `${VtPrefix.Csi}${CsiCommand.KittyUpdateFlags.prefix}4${CsiCommand.KittyUpdateFlags.final}` +
        KittySequence.QueryFlags +
        `${VtPrefix.Csi}${CsiCommand.ResetDecPrivateMode.prefix}${DecMode.SaveCursorAndAlternate}${CsiCommand.ResetDecPrivateMode.final}` +
        KittySequence.QueryFlags,
    );
    await screen.whenIdle();

    expect(responses).toEqual(["\x1b[?2u", "\x1b[?4u", "\x1b[?2u"]);
  });

  it("applies kitty modes, pop counts, bounded eviction, and per-buffer state", async () => {
    const responses: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: { cols: 20, rows: 5 },
        onResponse: (data) => responses.push(data),
      }),
    );
    const pushes = Array.from({ length: 65 }, (_, index) => `\x1b[>${index + 1}u`).join("");

    screen.feed(
      `\x1b[=1u\x1b[=2;2u${pushes}\x1b[<64u\x1b[?u` +
        `\x1b[?1049h\x1b[=4u\x1b[?u\x1b[?1049l\x1b[?u` +
        `\x1b[<999999999u\x1b[?u`,
    );
    await screen.whenIdle();

    expect(responses).toEqual(["\x1b[?1u", "\x1b[?4u", "\x1b[?1u", "\x1b[?0u"]);
  });

  it("does not treat private-mode subparameters as independent modes", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 5 } }));
    screen.feed("\x1b[?1000h\x1b[?25:1006h");
    await screen.whenIdle();

    expect(screen.mouseProtocol()).toEqual({ tracking: "vt200", encoding: "x10" });
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
