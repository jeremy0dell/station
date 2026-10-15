import { expect, it } from "vitest";
import type { TerminalOperation } from "../../src/terminalProtocol.js";
import { TerminalInputWindow } from "../../src/terminalRelay.js";

it("pipelines a full input window before the first acknowledgement", () => {
  const frames: TerminalOperation[] = [];
  const window = new TerminalInputWindow((frame) => frames.push(frame));
  window.input("x".repeat(96 * 1024));
  expect(frames).toHaveLength(2);
  window.acknowledge(1, 32 * 1024);
  expect(frames).toHaveLength(3);
  window.acknowledge(3, 96 * 1024);
  expect(window.disconnect()).toBe(false);
});
it("preserves Unicode, bracketed paste and ordered resize at exact byte counts", () => {
  const frames: TerminalOperation[] = [];
  const window = new TerminalInputWindow((frame) => frames.push(frame));
  const text = `\x1b[200~${"🎹é".repeat(12000)}\x1b[201~`;
  window.input(text);
  window.resize(100, 40);
  window.input("after");
  window.acknowledge(2, 65536 - 4);
  const inputs = frames.filter((frame) => frame.type === "input");
  expect(inputs.map((frame) => frame.data).join("")).toBe(`${text}after`);
  expect(inputs.every((frame) => Buffer.byteLength(frame.data) <= 32768)).toBe(true);
  expect(frames.at(-2)?.type).toBe("resize");
  const last = frames.at(-1);
  if (last === undefined) throw new Error("Missing frame");
  window.acknowledge(last.seq, Buffer.byteLength(`${text}after`));
});
it("never replays unacknowledged or queued input after disconnect", () => {
  const frames: TerminalOperation[] = [];
  const window = new TerminalInputWindow((frame) => frames.push(frame));
  window.input("x".repeat(100000));
  expect(window.disconnect()).toBe(true);
  expect(() => window.acknowledge(1, 32768)).toThrow();
  expect(frames).toHaveLength(2);
  const replacement: TerminalOperation[] = [];
  new TerminalInputWindow((frame) => replacement.push(frame)).input("new");
  expect(replacement).toEqual([{ type: "input", seq: 1, data: "new" }]);
});
it("bounds stalled input and resize queues and rejects forged acknowledgements", () => {
  const window = new TerminalInputWindow(() => {});
  expect(() => window.input("x".repeat(2 * 1024 * 1024))).toThrow(/1 MiB/);
  expect(() => window.acknowledge(1, 4)).toThrow(/mismatch/);
});
