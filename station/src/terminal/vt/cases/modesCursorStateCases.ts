import type { VtCase } from "./types.js";

export const modesCursorStateCases: readonly VtCase[] = [
  {
    name: "decsc/decrc save and restore cursor position and pen",
    feed: "\x1b[2;3H\x1b[31m\x1b7\x1b[5;1H\x1b[0mplain\x1b8X",
    expect: {
      // X lands at the saved position with the saved red pen.
      cells: [{ at: [1, 2], char: "X", fg: "#cd3131" }],
      cursor: { x: 3, y: 1 },
    },
  },
  {
    name: "decom origin mode addresses within the scroll region",
    feed: "\x1b[2;4r\x1b[?6h\x1b[1;1HO",
    expect: {
      // With DECOM on, row 1 means the region top (absolute row 2).
      cells: [{ at: [1, 0], char: "O" }],
      rows: ["", "O"],
    },
  },
  {
    name: "irm insert mode shifts existing content right",
    feed: "abc\x1b[1;1H\x1b[4hXY\x1b[4l",
    expect: {
      rows: ["XYabc"],
    },
  },
  {
    name: "ri reverse-scrolls when the cursor is at the top",
    feed: "top\x1b[1;1H\x1bMnew",
    expect: {
      // RI at row 1 scrolls down: old content moves to row 2.
      rows: ["new", "top"],
    },
  },
];
