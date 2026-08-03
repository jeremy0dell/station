import { describe, expect, it } from "bun:test";
import {
  BracketedPasteMarker,
  CsiSequence,
  CursorPresentationStyle,
  setGraphicsRendition,
} from "./csi.js";
import { DecMode } from "./decset.js";
import { CsiCommand } from "./identifiers.js";
import { VtPrefix } from "./syntax.js";

describe("CSI protocol vocabulary", () => {
  it("pins complete parameterless and fixed-parameter sequences", () => {
    expect(CsiSequence.CursorHome).toBe("\x1b[H");
    expect(CsiSequence.ResetScrollRegion).toBe("\x1b[r");
    expect(CsiSequence.ResetGraphicsRendition).toBe("\x1b[0m");
    expect(CsiSequence.SetLineFeedNewLine).toBe("\x1b[20h");
    expect(CsiSequence.ResetLineFeedNewLine).toBe("\x1b[20l");
    expect(CsiSequence.EraseEntireDisplay).toBe("\x1b[2J");
    expect(CsiSequence.EraseScrollback).toBe("\x1b[3J");
  });

  it("composes dynamic parameters from typed values", () => {
    expect(
      `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.BracketedPaste}${CsiCommand.SetDecPrivateMode.final}`,
    ).toBe("\x1b[?2004h");
    expect(`${VtPrefix.Csi}3;4${CsiCommand.CursorPosition.final}`).toBe("\x1b[3;4H");
    expect(`${VtPrefix.Csi}2;5${CsiCommand.SetScrollingRegion.final}`).toBe("\x1b[2;5r");
    expect(`${VtPrefix.Csi}12${CsiCommand.EraseCharacters.final}`).toBe("\x1b[12X");
    expect(
      `${VtPrefix.Csi}${CursorPresentationStyle.SteadyBar}${CsiCommand.SelectCursorStyle.intermediates}${CsiCommand.SelectCursorStyle.final}`,
    ).toBe("\x1b[6 q");
    expect(setGraphicsRendition([38, 2, 1, 2, 3])).toBe("\x1b[38;2;1;2;3m");
  });

  it("pins paired bracketed-paste markers", () => {
    expect(`${BracketedPasteMarker.Start}a\nb${BracketedPasteMarker.End}`).toBe(
      "\x1b[200~a\nb\x1b[201~",
    );
  });
});
