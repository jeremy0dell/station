import { AnsiMode } from "./decset.js";
import { CsiCommand } from "./identifiers.js";
import { VtPrefix } from "./syntax.js";

/** ED parameters supported by Station. */
export const EraseDisplayMode = {
  CursorToEnd: 0,
  StartToCursor: 1,
  EntireDisplay: 2,
  Scrollback: 3,
} as const;
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
  CursorHome: `${VtPrefix.Csi}${CsiCommand.CursorPosition.final}`,
  ResetScrollRegion: `${VtPrefix.Csi}${CsiCommand.SetScrollingRegion.final}`,
  ResetGraphicsRendition: `${VtPrefix.Csi}0${CsiCommand.SelectGraphicRendition.final}`,
  SetLineFeedNewLine: `${VtPrefix.Csi}${AnsiMode.LineFeedNewLine}${CsiCommand.SetAnsiMode.final}`,
  ResetLineFeedNewLine: `${VtPrefix.Csi}${AnsiMode.LineFeedNewLine}${CsiCommand.ResetAnsiMode.final}`,
  EraseEntireDisplay: `${VtPrefix.Csi}${EraseDisplayMode.EntireDisplay}${CsiCommand.EraseInDisplay.final}`,
  EraseScrollback: `${VtPrefix.Csi}${EraseDisplayMode.Scrollback}${CsiCommand.EraseInDisplay.final}`,
} as const;

/** Paired markers for a bracketed-paste payload. */
export const BracketedPasteMarker = {
  Start: `${VtPrefix.Csi}200~`,
  End: `${VtPrefix.Csi}201~`,
} as const;

/** Encode an SGR parameter list without interpreting its dynamic color values. */
export function setGraphicsRendition(params: readonly number[]): string {
  return `${VtPrefix.Csi}${params.join(";")}${CsiCommand.SelectGraphicRendition.final}`;
}
