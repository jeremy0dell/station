import { charsetMiscCases } from "./charsetMiscCases.js";
import { cursorEraseCases } from "./cursorEraseCases.js";
import { modesCursorStateCases } from "./modesCursorStateCases.js";
import { screenModeCases } from "./screenModeCases.js";
import { scrollbackCases } from "./scrollbackCases.js";
import { sgrCases } from "./sgrCases.js";
import type { VtCase } from "./types.js";
import { wrapWideCases } from "./wrapWideCases.js";

export const allVtCases: readonly VtCase[] = [
  ...sgrCases,
  ...cursorEraseCases,
  ...screenModeCases,
  ...modesCursorStateCases,
  ...wrapWideCases,
  ...scrollbackCases,
  ...charsetMiscCases,
];

export type { VtCase, VtCellExpectation } from "./types.js";
