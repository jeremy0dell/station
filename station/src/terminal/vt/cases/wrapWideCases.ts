import type { VtCase } from "./types.js";

export const wrapWideCases: readonly VtCase[] = [
  {
    name: "wrap continues output on the next row",
    feed: "x".repeat(25),
    expect: {
      rows: ["x".repeat(20), "x".repeat(5)],
      cursor: { x: 5, y: 1 },
    },
  },
  {
    name: "pending wrap holds at the last column until the next char",
    feed: "x".repeat(20),
    expect: {
      rows: ["x".repeat(20), ""],
      cursor: { x: 20, y: 0 },
    },
  },
  {
    name: "pending wrap consumes the next printable",
    feed: `${"x".repeat(20)}Y`,
    expect: {
      rows: ["x".repeat(20), "Y"],
      cursor: { x: 1, y: 1 },
    },
  },
  {
    name: "carriage return cancels a pending wrap",
    feed: `${"x".repeat(20)}\rZ`,
    expect: {
      rows: [`Z${"x".repeat(19)}`, ""],
      cursor: { x: 1, y: 0 },
    },
  },
  {
    name: "decawm off overwrites the last column instead of wrapping",
    feed: "\x1b[?7l0123456789012345678901234",
    expect: {
      rows: ["01234567890123456784", ""],
    },
  },
  {
    name: "cjk wide char occupies two columns",
    feed: "漢X",
    expect: {
      cells: [
        { at: [0, 0], char: "漢" },
        { at: [0, 2], char: "X" },
      ],
      cursor: { x: 3, y: 0 },
    },
  },
  {
    name: "cjk wide char at the last column wraps wholly",
    feed: "\x1b[1;20H漢",
    expect: {
      rows: ["", "漢"],
      cells: [{ at: [1, 0], char: "漢" }],
    },
  },
  {
    name: "emoji renders as a wide cell",
    feed: "\u{1F600}X",
    expect: {
      cells: [
        { at: [0, 0], char: "\u{1F600}" },
        { at: [0, 2], char: "X" },
      ],
    },
  },
  {
    // Pins current engine behavior so upgrades that change ZWJ handling are
    // caught; unicode11 widths do not cluster ZWJ sequences (3 wide cells).
    name: "zwj sequence behavior is pinned",
    feed: "\u{1F469}‍\u{1F469}‍\u{1F467}",
    expect: {
      cursor: { x: 6, y: 0 },
    },
  },
];
