import type { VtCase } from "./types.js";

export const charsetMiscCases: readonly VtCase[] = [
  {
    // ncurses line-drawing (htop/dialog borders) designates the DEC special
    // graphics charset; xterm translates it to Unicode box-drawing chars.
    name: "dec special graphics translate to unicode box drawing",
    feed: "\x1b(0lqqk\x1b(B",
    expect: {
      rows: ["┌──┐"],
    },
  },
  {
    name: "default tab stops land every 8 columns",
    feed: "A\tB",
    expect: {
      rows: ["A       B"],
      cursor: { x: 9, y: 0 },
    },
  },
  {
    name: "hts sets a custom tab stop",
    feed: "\x1b[1;5H\x1bH\r\t",
    expect: {
      cursor: { x: 4, y: 0 },
    },
  },
  {
    name: "tbc 3 clears all tab stops",
    feed: "\x1b[1;5H\x1bH\x1b[3g\r\t",
    expect: {
      cursor: { x: 19, y: 0 },
    },
  },
  {
    name: "rep repeats the preceding character",
    feed: "ab\x1b[3b",
    expect: {
      rows: ["abbbb"],
      cursor: { x: 5, y: 0 },
    },
  },
];
