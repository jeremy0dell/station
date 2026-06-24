import { TextAttributes } from "@opentui/core";
import type { VtCase } from "./types.js";

export const cursorEraseCases: readonly VtCase[] = [
  {
    name: "cup positions the cursor",
    feed: "\x1b[3;5H",
    expect: {
      cursor: { x: 4, y: 2 },
    },
  },
  {
    name: "relative cursor moves compose",
    feed: "\x1b[3;5H\x1b[2A\x1b[3C\x1b[1B\x1b[4D",
    expect: {
      cursor: { x: 3, y: 1 },
    },
  },
  {
    name: "el 0 erases from the cursor to end of line",
    feed: "abcdef\x1b[1;4H\x1b[K",
    expect: {
      rows: ["abc"],
    },
  },
  {
    name: "el 1 erases from start of line through the cursor",
    feed: "abcdef\x1b[1;4H\x1b[1K",
    expect: {
      rows: ["    ef"],
    },
  },
  {
    name: "el 2 erases the whole line",
    feed: "abcdef\x1b[2K",
    expect: {
      rows: [""],
    },
  },
  {
    name: "ed 0 erases from the cursor to screen end",
    feed: "AA\r\nBB\r\nCC\x1b[2;1H\x1b[J",
    expect: {
      rows: ["AA", "", ""],
    },
  },
  {
    name: "ed 1 erases from screen start through the cursor",
    feed: "AA\r\nBB\r\nCC\x1b[2;2H\x1b[1J",
    expect: {
      rows: ["", "", "CC"],
    },
  },
  {
    name: "ed 2 clears the screen without moving the cursor",
    feed: "AA\r\nBB\x1b[2J",
    expect: {
      rows: ["", ""],
      cursor: { x: 2, y: 1 },
    },
  },
  {
    name: "ech erases n characters without moving",
    feed: "abcdef\x1b[1;2H\x1b[3X",
    expect: {
      rows: ["a   ef"],
      cursor: { x: 1, y: 0 },
    },
  },
  {
    name: "ich inserts blanks shifting the rest right",
    feed: "abcdef\x1b[1;3H\x1b[2@",
    expect: {
      rows: ["ab  cdef"],
    },
  },
  {
    name: "dch deletes characters shifting the rest left",
    feed: "abcdef\x1b[1;3H\x1b[2P",
    expect: {
      rows: ["abef"],
    },
  },
  {
    name: "il inserts a line shifting rows down",
    feed: "AA\r\nBB\r\nCC\x1b[2;1H\x1b[L",
    expect: {
      rows: ["AA", "", "BB", "CC"],
    },
  },
  {
    name: "dl deletes a line shifting rows up",
    feed: "AA\r\nBB\r\nCC\x1b[2;1H\x1b[M",
    expect: {
      rows: ["AA", "CC", ""],
    },
  },
  {
    name: "bce paints erased cells with the active background",
    feed: "\x1b[44m\x1b[2J",
    expect: {
      cells: [
        { at: [0, 0], bg: "#2472c8" },
        { at: [5, 19], bg: "#2472c8" },
      ],
    },
  },
  {
    name: "styled whitespace statusline survives trimming",
    feed: "\x1b[7m   \x1b[0m",
    expect: {
      cells: [{ at: [0, 1], attributes: TextAttributes.INVERSE }],
    },
  },
];
