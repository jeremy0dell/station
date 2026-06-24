import type { VtCase } from "./types.js";

export const scrollbackCases: readonly VtCase[] = [
  {
    name: "scrolled lines accumulate in scrollback",
    size: { cols: 20, rows: 4 },
    scrollback: 100,
    feed: Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\r\n"),
    expect: {
      baseY: 6,
      rows: ["line-6", "line-7", "line-8", "line-9"],
    },
  },
  {
    name: "scrollback trims at the configured cap",
    size: { cols: 20, rows: 4 },
    scrollback: 50,
    feed: Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\r\n"),
    expect: {
      bufferLengthAtMost: 54,
      rows: ["line-196", "line-197", "line-198", "line-199"],
    },
  },
];
