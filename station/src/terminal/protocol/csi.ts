import { AnsiMode } from "./decset.js";
import { VtPrefix } from "./syntax.js";

/** ED parameters supported by Station. */
export const EraseDisplayMode = {
  CursorToEnd: 0,
  CursorToBeginning: 1,
  EntireDisplay: 2,
  Scrollback: 3,
} as const;
export type EraseDisplayModeValue =
  (typeof EraseDisplayMode)[keyof typeof EraseDisplayMode];

/** DECSCUSR presentation values emitted during Host restoration. */
export const CursorPresentationStyle = {
  BlinkingBlock: 1,
  SteadyBlock: 2,
  BlinkingUnderline: 3,
  SteadyUnderline: 4,
  BlinkingBar: 5,
  SteadyBar: 6,
} as const;
export type CursorPresentationStyleValue =
  (typeof CursorPresentationStyle)[keyof typeof CursorPresentationStyle];

/** Complete CSI sequences with no runtime parameters. */
export const CsiSequence = {
  CursorHome: `${VtPrefix.Csi}H`,
  ResetScrollRegion: `${VtPrefix.Csi}r`,
  ResetGraphicsRendition: `${VtPrefix.Csi}0m`,
  SetLineFeedNewLine: `${VtPrefix.Csi}${AnsiMode.LineFeedNewLine}h`,
  ResetLineFeedNewLine: `${VtPrefix.Csi}${AnsiMode.LineFeedNewLine}l`,
  EraseEntireDisplay: `${VtPrefix.Csi}${EraseDisplayMode.EntireDisplay}J`,
  EraseScrollback: `${VtPrefix.Csi}${EraseDisplayMode.Scrollback}J`,
} as const;

/** Paired markers for a bracketed-paste payload. */
export const BracketedPasteMarker = {
  Start: `${VtPrefix.Csi}200~`,
  End: `${VtPrefix.Csi}201~`,
} as const;

/** Encode an SGR parameter list without interpreting its dynamic color values. */
export function setGraphicsRendition(params: readonly number[]): string {
  return `${VtPrefix.Csi}${params.join(";")}m`;
}
