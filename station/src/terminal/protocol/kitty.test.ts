import { describe, expect, it } from "bun:test";
import {
  initialKittyKeyboardState,
  KittyFlagUpdateMode,
  KittySequence,
  reduceKittyKeyboardState,
  serializeKittyKeyboardState,
} from "./kitty.js";
import { CsiCommand } from "./identifiers.js";
import { VtPrefix } from "./syntax.js";

describe("Kitty keyboard protocol", () => {
  it("applies set, OR, and AND-NOT modes without mutating prior state", () => {
    const initial = initialKittyKeyboardState();
    const set = reduceKittyKeyboardState(initial, {
      type: "update",
      flags: 0b0011,
      mode: KittyFlagUpdateMode.Set,
    });
    const or = reduceKittyKeyboardState(set, {
      type: "update",
      flags: 0b0100,
      mode: KittyFlagUpdateMode.SetBits,
    });
    const cleared = reduceKittyKeyboardState(or, {
      type: "update",
      flags: 0b0010,
      mode: KittyFlagUpdateMode.ClearBits,
    });

    expect(initial).toEqual({ flags: 0, stack: [] });
    expect(set.flags).toBe(0b0011);
    expect(or.flags).toBe(0b0111);
    expect(cleared.flags).toBe(0b0101);
  });

  it("pushes, pops by count, resets on over-pop, and evicts the oldest entry", () => {
    let state = initialKittyKeyboardState();
    for (let flags = 1; flags <= 65; flags += 1) {
      state = reduceKittyKeyboardState(state, { type: "push", flags });
    }
    expect(state.stack).toHaveLength(64);
    expect(state.stack[0]).toBe(1);
    expect(state.flags).toBe(65);

    state = reduceKittyKeyboardState(state, { type: "pop", count: 2 });
    expect(state.flags).toBe(63);
    expect(state.stack).toHaveLength(62);

    state = reduceKittyKeyboardState(state, { type: "pop", count: 999 });
    expect(state).toEqual({ flags: 0, stack: [] });
  });

  it("pins transition, query, reply, and state serialization bytes", () => {
    expect(`${VtPrefix.Csi}${CsiCommand.KittyUpdateFlags.prefix}5${CsiCommand.KittyUpdateFlags.final}`).toBe("\x1b[=5u");
    expect(
      `${VtPrefix.Csi}${CsiCommand.KittyUpdateFlags.prefix}2;${KittyFlagUpdateMode.SetBits}${CsiCommand.KittyUpdateFlags.final}`,
    ).toBe("\x1b[=2;2u");
    expect(`${VtPrefix.Csi}${CsiCommand.KittyPushFlags.prefix}7${CsiCommand.KittyPushFlags.final}`).toBe("\x1b[>7u");
    expect(`${VtPrefix.Csi}${CsiCommand.KittyPopFlags.prefix}${CsiCommand.KittyPopFlags.final}`).toBe("\x1b[<u");
    expect(`${VtPrefix.Csi}${CsiCommand.KittyPopFlags.prefix}3${CsiCommand.KittyPopFlags.final}`).toBe("\x1b[<3u");
    expect(KittySequence.QueryFlags).toBe("\x1b[?u");
    expect(`${VtPrefix.Csi}${CsiCommand.KittyQueryFlags.prefix}5${CsiCommand.KittyQueryFlags.final}`).toBe("\x1b[?5u");
    expect(serializeKittyKeyboardState({ flags: 5, stack: [1, 3] })).toBe(
      "\x1b[=1u\x1b[>3u\x1b[>5u",
    );
    expect(serializeKittyKeyboardState({ flags: 5, stack: [0] })).toBe(
      "\x1b[>5u",
    );
  });
});
