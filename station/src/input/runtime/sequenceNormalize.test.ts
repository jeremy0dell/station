import { describe, expect, it } from "bun:test";
import { normalizeSequence } from "./sequenceNormalize.js";

const TMUX_STARTUP_BURST =
  "\x1b]10;rgb:ffff/ffff/ffff\x07" +
  "\x1b]11;rgb:2828/2c2c/3434\x07" +
  "\x1bP>|tmux 3.6b\x1b\\" +
  "\x1b[7;1R\x1b[1;1R\x1b[1;1R" +
  "\x1b[?997;1n" +
  "\x1b[4;2040;2704t";

describe("normalizeSequence", () => {
  it("consumes pure reply bursts", () => {
    expect(normalizeSequence(TMUX_STARTUP_BURST)).toEqual({ consumed: true });
  });

  it("consumes kitty key releases", () => {
    expect(normalizeSequence("\x1b[111;5:3u")).toEqual({ consumed: true });
  });

  it("translates kitty chords to legacy bytes", () => {
    expect(normalizeSequence("\x1b[111;5u")).toEqual({ consumed: false, legacy: "\x0f" });
  });

  it("translates xterm Shift+Enter according to preserve mode", () => {
    expect(normalizeSequence("\x1b[27;2;13~")).toEqual({ consumed: false, legacy: "\r" });
    expect(normalizeSequence("\x1b[27;2;13~", { preserveModifiedEnter: true })).toEqual({
      consumed: false,
      legacy: "\x1b[13;2u",
    });
  });

  it("passes ordinary bytes through", () => {
    expect(normalizeSequence("a")).toEqual({ consumed: false, legacy: "a" });
  });
});
