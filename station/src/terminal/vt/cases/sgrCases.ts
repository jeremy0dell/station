import { TextAttributes } from "@opentui/core";
import type { VtCase } from "./types.js";

export const sgrCases: readonly VtCase[] = [
  {
    name: "sgr 16-color foreground maps to the ansi palette",
    feed: "\x1b[31mred",
    expect: {
      rows: ["red"],
      cells: [{ at: [0, 0], char: "r", fg: "#cd3131" }],
    },
  },
  {
    name: "sgr bright foreground maps to the bright palette",
    feed: "\x1b[92mok",
    expect: {
      cells: [{ at: [0, 0], fg: "#23d18b" }],
    },
  },
  {
    name: "sgr 256-color cube resolves cube levels",
    feed: "\x1b[38;5;196mX",
    expect: {
      cells: [{ at: [0, 0], char: "X", fg: "#ff0000" }],
    },
  },
  {
    name: "sgr 256-color grayscale ramp resolves",
    feed: "\x1b[48;5;244m ",
    expect: {
      cells: [{ at: [0, 0], bg: "#808080" }],
    },
  },
  {
    name: "sgr truecolor passes through exact rgb",
    feed: "\x1b[38;2;1;2;3mX",
    expect: {
      cells: [{ at: [0, 0], char: "X", fg: "#010203" }],
    },
  },
  {
    name: "sgr attribute set: bold dim italic underline",
    feed: "\x1b[1;2;3;4mX",
    expect: {
      cells: [
        {
          at: [0, 0],
          attributes:
            TextAttributes.BOLD |
            TextAttributes.DIM |
            TextAttributes.ITALIC |
            TextAttributes.UNDERLINE,
        },
      ],
    },
  },
  {
    name: "sgr attribute set: inverse hidden strikethrough",
    feed: "\x1b[7;8;9mX",
    expect: {
      cells: [
        {
          at: [0, 0],
          attributes:
            TextAttributes.INVERSE | TextAttributes.HIDDEN | TextAttributes.STRIKETHROUGH,
        },
      ],
    },
  },
  {
    name: "sgr blink is deliberately dropped",
    feed: "\x1b[5mX",
    expect: {
      cells: [{ at: [0, 0], char: "X", attributes: 0 }],
    },
  },
  {
    name: "sgr partial resets clear only their attribute",
    feed: "\x1b[1;4;31mab\x1b[22;24;39mcd",
    expect: {
      rows: ["abcd"],
      cells: [
        {
          at: [0, 0],
          fg: "#cd3131",
          attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE,
        },
        { at: [0, 2], char: "c", fgDefault: true, attributes: 0 },
      ],
    },
  },
  {
    name: "sgr 0 resets everything mid-line",
    feed: "\x1b[1;31mAB\x1b[0mCD",
    expect: {
      cells: [
        { at: [0, 0], fg: "#cd3131", attributes: TextAttributes.BOLD },
        { at: [0, 2], char: "C", fgDefault: true, attributes: 0 },
      ],
    },
  },
  {
    name: "split csi across a chunk boundary still styles",
    feed: ["\x1b[3", "1mred"],
    expect: {
      rows: ["red"],
      cells: [{ at: [0, 0], fg: "#cd3131" }],
    },
  },
];
