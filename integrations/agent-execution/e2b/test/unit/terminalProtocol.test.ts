import { expect, it } from "vitest";
import { TerminalClientFrameSchema, TerminalGrantSchema } from "../../src/terminalProtocol.js";

it("strictly validates input operations and UTF-8 frame byte limits", () => {
  expect(
    TerminalClientFrameSchema.safeParse({ type: "input", seq: 1, data: "🎹".repeat(8192) }).success,
  ).toBe(true);
  for (const frame of [
    { type: "input", seq: 1, data: "🎹".repeat(8193) },
    { type: "resize", seq: 1, cols: 80, rows: 24, command: "spawn" },
    { type: "input", seq: -1, data: "x" },
  ])
    expect(TerminalClientFrameSchema.safeParse(frame).success).toBe(false);
});
it("rejects credentials in WebSocket URLs and unencrypted attachment addresses", () => {
  for (const address of [
    "ws://example.test",
    "wss://user:secret@example.test",
    "wss://example.test/?ticket=secret",
  ]) {
    expect(TerminalGrantSchema.shape.address.safeParse(address).success).toBe(false);
  }
});
