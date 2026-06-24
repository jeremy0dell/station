import { describe, expect, it } from "bun:test";
import { buildOsc52Sequence } from "./osc52.js";

describe("buildOsc52Sequence", () => {
  it("wraps base64-encoded UTF-8 in the OSC 52 clipboard envelope", () => {
    expect(buildOsc52Sequence("hi")).toBe(`\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`);
  });

  it("encodes multi-byte text", () => {
    const seq = buildOsc52Sequence("café 漢");
    expect(seq.startsWith("\x1b]52;c;")).toBe(true);
    expect(seq.endsWith("\x07")).toBe(true);
    const base64 = seq.slice("\x1b]52;c;".length, -1);
    expect(Buffer.from(base64, "base64").toString("utf8")).toBe("café 漢");
  });
});
