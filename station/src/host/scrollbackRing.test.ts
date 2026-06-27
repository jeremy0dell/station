import { describe, expect, it } from "bun:test";
import { ScrollbackRing } from "./scrollbackRing.js";

describe("ScrollbackRing", () => {
  it("keeps all entries while under budget and reports not truncated", () => {
    const ring = new ScrollbackRing(1024);
    ring.push("alpha");
    ring.push("beta");
    expect(ring.snapshot()).toEqual({ scrollback: ["alpha", "beta"], truncated: false });
  });

  it("drops oldest whole entries past the byte budget and flags truncated", () => {
    const ring = new ScrollbackRing(10);
    ring.push("aaaaa"); // 5 bytes
    ring.push("bbbbb"); // 10 bytes total — still within budget
    ring.push("ccccc"); // 15 bytes — over budget, drops "aaaaa"
    const snapshot = ring.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.scrollback).toEqual(["bbbbb", "ccccc"]);
  });

  it("never drops the only (newest) entry even when it alone exceeds the budget", () => {
    const ring = new ScrollbackRing(4);
    ring.push("this-one-entry-is-huge");
    expect(ring.snapshot().scrollback).toEqual(["this-one-entry-is-huge"]);
  });

  it("ignores empty chunks", () => {
    const ring = new ScrollbackRing(1024);
    ring.push("");
    expect(ring.snapshot()).toEqual({ scrollback: [], truncated: false });
  });

  it("prepends a mode-restore preamble for modes set in dropped chunks", () => {
    const ring = new ScrollbackRing(10);
    ring.push("\x1b[?1049h"); // enter alt screen (8 bytes) — will be dropped
    ring.push("aaaaa"); // over budget -> drops the alt-screen-enter chunk
    ring.push("bbbbb");
    const snapshot = ring.snapshot();
    expect(snapshot.truncated).toBe(true);
    // The surviving chunks alone would replay into a normal-screen VT; the
    // preamble re-enters the alt screen first.
    expect(snapshot.scrollback[0]).toBe("\x1b[?1049h");
    expect(snapshot.scrollback.slice(1)).toEqual(["aaaaa", "bbbbb"]);
  });

  it("adds no preamble when the dropped chunks set no sticky modes", () => {
    const ring = new ScrollbackRing(10);
    ring.push("aaaaa");
    ring.push("bbbbb");
    ring.push("ccccc"); // drops "aaaaa" — plain text, nothing to restore
    expect(ring.snapshot().scrollback).toEqual(["bbbbb", "ccccc"]);
  });
});
