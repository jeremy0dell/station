import type { StationTerminalSize } from "../../types.js";

export type VtCellExpectation = {
  at: [row: number, col: number];
  char?: string;
  fg?: string;
  bg?: string;
  /** Assert the cell carries no explicit color (theme default applies). */
  fgDefault?: true;
  bgDefault?: true;
  /** Exact TextAttributes mask for the span covering this cell. */
  attributes?: number;
};

export type VtCase = {
  name: string;
  size?: StationTerminalSize;
  scrollback?: number;
  /** An array feeds chunks separately, exercising split-escape boundaries. */
  feed: string | readonly string[];
  expect: {
    /** Per visible row, right-trimmed (translateToString(true) semantics). */
    rows?: readonly string[];
    cells?: readonly VtCellExpectation[];
    cursor?: { x: number; y: number };
    altScreen?: boolean;
    /** Lines pushed to scrollback (0 = none). */
    baseY?: number;
    bufferLengthAtMost?: number;
  };
};
