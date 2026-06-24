import type { VtCase } from "./types.js";

export const screenModeCases: readonly VtCase[] = [
  {
    name: "alt screen 1049 enter shows a clean buffer",
    feed: "primary\x1b[?1049h",
    expect: {
      altScreen: true,
      rows: [""],
    },
  },
  {
    name: "alt screen 1049 exit restores primary content and cursor",
    feed: "primary\x1b[?1049h\x1b[2J\x1b[HALT\x1b[?1049l",
    expect: {
      altScreen: false,
      rows: ["primary"],
      cursor: { x: 7, y: 0 },
    },
  },
  {
    name: "alt screen output does not enter scrollback",
    size: { cols: 20, rows: 4 },
    scrollback: 50,
    feed: `primary\x1b[?1049h${"altline\r\n".repeat(30)}\x1b[?1049l`,
    expect: {
      altScreen: false,
      baseY: 0,
      rows: ["primary"],
    },
  },
  {
    name: "decstbm scrolls only inside the region and skips scrollback",
    feed: "A\r\nB\r\nC\r\nD\r\nE\r\nF\x1b[2;4r\x1b[4;1H\n",
    expect: {
      rows: ["A", "C", "D", "", "E", "F"],
      baseY: 0,
    },
  },
  {
    name: "ris clears the screen and homes the cursor",
    feed: "\x1b[31mred\x1bc",
    expect: {
      rows: [""],
      cursor: { x: 0, y: 0 },
    },
  },
  {
    name: "clear plus home behaves like a fresh screen",
    feed: "abc\x1b[2J\x1b[H",
    expect: {
      rows: [""],
      cursor: { x: 0, y: 0 },
    },
  },
];
