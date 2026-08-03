import { C0 } from "./syntax.js";

/** Complete ESC sequences emitted directly by Station. */
export const EscSequence = {
  /** RIS — Reset to Initial State. */
  ResetToInitialState: `${C0.Escape}c`,
  /** DECSC — save cursor and presentation state. */
  SaveCursor: `${C0.Escape}7`,
} as const;
