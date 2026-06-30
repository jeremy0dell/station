import { describe, expect, it } from "bun:test";
import { createStationStore } from "../../state/store.js";
import type { StationState } from "../../state/types.js";
import { createKeymapStack, type KeymapLayer } from "./keymaps.js";

const state: StationState = createStationStore().getState();

function layer(overrides: Partial<KeymapLayer<string>> & { id: KeymapLayer<string>["id"] }): KeymapLayer<string> {
  return { isActive: () => true, bindings: [], ...overrides };
}

describe("createKeymapStack", () => {
  it("resolves bindings by priority order regardless of registration order", () => {
    const stack = createKeymapStack<string>([
      layer({ id: "workspace", bindings: [{ keys: ["x"], action: () => "workspace" }] }),
      layer({ id: "overlay", bindings: [{ keys: ["x"], action: () => "overlay" }] }),
      layer({ id: "context-menu", bindings: [{ keys: ["x"], action: () => "context-menu" }] }),
    ]);
    expect(stack.resolve("x", state)).toEqual("context-menu");
  });

  it("skips inactive layers", () => {
    const stack = createKeymapStack<string>([
      layer({
        id: "overlay",
        isActive: () => false,
        bindings: [{ keys: ["x"], action: () => "overlay" }],
      }),
      layer({ id: "workspace", bindings: [{ keys: ["x"], action: () => "workspace" }] }),
    ]);
    expect(stack.resolve("x", state)).toEqual("workspace");
  });

  it("lets a catch-all claim non-reserved keys before lower layers", () => {
    const stack = createKeymapStack<string>([
      layer({ id: "terminal", catchAll: (key) => `passthrough:${key}` }),
      layer({ id: "workspace", bindings: [{ keys: ["x"], action: () => "workspace" }] }),
    ]);
    expect(stack.resolve("x", state)).toEqual("passthrough:x");
  });

  it("lets reserved keys fall through an active catch-all to a lower binding", () => {
    const stack = createKeymapStack<string>([
      layer({ id: "overlay", catchAll: () => "swallowed" }),
      layer({ id: "terminal", catchAll: (key) => `passthrough:${key}` }),
      layer({
        id: "workspace",
        bindings: [{ keys: ["\x11"], reserved: true, action: () => "exit" }],
      }),
    ]);
    expect(stack.resolve("\x11", state)).toEqual("exit");
    expect(stack.resolve("a", state)).toEqual("swallowed");
  });

  it("lets an explicit higher-layer binding win even for reserved keys", () => {
    const stack = createKeymapStack<string>([
      layer({ id: "dialog", bindings: [{ keys: ["\x11"], action: () => "dialog-override" }] }),
      layer({
        id: "workspace",
        bindings: [{ keys: ["\x11"], reserved: true, action: () => "exit" }],
      }),
    ]);
    expect(stack.resolve("\x11", state)).toEqual("dialog-override");
  });

  it("prefers an explicit binding over the same layer's catch-all", () => {
    const stack = createKeymapStack<string>([
      layer({
        id: "terminal",
        bindings: [{ keys: ["x"], action: () => "bound" }],
        catchAll: () => "passthrough",
      }),
    ]);
    expect(stack.resolve("x", state)).toEqual("bound");
    expect(stack.resolve("y", state)).toEqual("passthrough");
  });

  it("derives the reserved set from registrations across layers", () => {
    const stack = createKeymapStack<string>([
      layer({
        id: "workspace",
        bindings: [
          { keys: ["\x11", "\x0f"], reserved: true, action: () => "chord" },
          { keys: ["n"], action: () => "plain" },
        ],
      }),
    ]);
    expect([...stack.reservedKeys].sort()).toEqual(["\x0f", "\x11"]);
  });

  it("returns undefined when no active layer claims the key", () => {
    const stack = createKeymapStack<string>([
      layer({ id: "workspace", bindings: [{ keys: ["x"], action: () => "workspace" }] }),
    ]);
    expect(stack.resolve("y", state)).toBeUndefined();
  });

  it("throws on a duplicate key within a layer", () => {
    expect(() =>
      createKeymapStack<string>([
        layer({
          id: "workspace",
          bindings: [
            { keys: ["x"], action: () => "first" },
            { keys: ["x"], action: () => "second" },
          ],
        }),
      ]),
    ).toThrow(/duplicate key binding/);
  });

  it("throws on a duplicate layer id", () => {
    expect(() =>
      createKeymapStack<string>([layer({ id: "workspace" }), layer({ id: "workspace" })]),
    ).toThrow(/duplicate keymap layer/);
  });
});
