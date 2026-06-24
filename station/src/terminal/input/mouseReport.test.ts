import { describe, expect, it } from "bun:test";
import { buildMouseReportSequence, type MouseReportEvent } from "./mouseReport.js";

const base = {
  col: 3,
  row: 1,
  modifiers: { shift: false, alt: false, ctrl: false },
  encoding: "sgr",
} as const satisfies Omit<MouseReportEvent, "action" | "button">;

describe("buildMouseReportSequence", () => {
  it("encodes an SGR left click as a press then release at the cell", () => {
    expect(buildMouseReportSequence({ ...base, action: "press", button: "left" })).toBe(
      "\x1b[<0;3;1M",
    );
    // Release keeps the button (0) but lowercases the final byte.
    expect(buildMouseReportSequence({ ...base, action: "release", button: "left" })).toBe(
      "\x1b[<0;3;1m",
    );
  });

  it("encodes buttonless SGR hover motion with the motion bit set", () => {
    expect(buildMouseReportSequence({ ...base, action: "motion", button: "none" })).toBe(
      "\x1b[<35;3;1M",
    );
  });

  it("folds modifier bits into the button code", () => {
    expect(
      buildMouseReportSequence({
        ...base,
        action: "press",
        button: "left",
        modifiers: { shift: true, alt: false, ctrl: true },
      }),
    ).toBe("\x1b[<20;3;1M"); // 0 + shift(4) + ctrl(16)
  });

  it("sets the meta bit for an alt-modified report", () => {
    expect(
      buildMouseReportSequence({
        ...base,
        action: "press",
        button: "left",
        modifiers: { shift: false, alt: true, ctrl: false },
      }),
    ).toBe("\x1b[<8;3;1M"); // 0 + alt(8)
  });

  it("encodes legacy X10 reports with the +32 byte offset and a 3-coded release", () => {
    // press: cb 0 -> ' ' (32); col 3 -> '#' (35); row 1 -> '!' (33)
    expect(
      buildMouseReportSequence({ ...base, action: "press", button: "left", encoding: "x10" }),
    ).toBe("\x1b[M \x23\x21");
    // legacy can't carry the button on release, so it collapses to code 3.
    expect(
      buildMouseReportSequence({ ...base, action: "release", button: "left", encoding: "x10" }),
    ).toBe("\x1b[M\x23\x23\x21");
  });

  it("clamps legacy cells that overflow the single-byte range", () => {
    const seq = buildMouseReportSequence({
      action: "press",
      button: "left",
      col: 500,
      row: 500,
      modifiers: base.modifiers,
      encoding: "x10",
    });
    // 223 is the max cell; 223 + 32 = 255 (the top byte).
    expect(seq).toBe(`\x1b[M${String.fromCharCode(32)}${String.fromCharCode(255)}${String.fromCharCode(255)}`);
  });
});
