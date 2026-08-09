import { describe, expect, it } from "bun:test";
import { TerminalProcessEmitter } from "./terminalProcessEmitter.js";

describe("TerminalProcessEmitter", () => {
  it("replays data emitted before the first subscriber", () => {
    const events = new TerminalProcessEmitter();
    events.emitData("before-");
    events.emitData("subscribe");

    const received: string[] = [];
    events.onData((data) => received.push(data));

    expect(received).toEqual(["before-", "subscribe"]);
  });

  it("delivers an already-recorded exit to a late subscriber", () => {
    const events = new TerminalProcessEmitter();
    events.emitExit({ exitCode: 7, signal: 9 });

    const exits: unknown[] = [];
    events.onExit((event) => exits.push(event));

    expect(exits).toEqual([{ exitCode: 7, signal: 9 }]);
  });

  it("emits only the first exit", () => {
    const events = new TerminalProcessEmitter();
    const exits: unknown[] = [];
    events.onExit((event) => exits.push(event));

    events.emitExit({ exitCode: 3 });
    events.emitExit({ exitCode: 4, signal: 15 });

    expect(exits).toEqual([{ exitCode: 3 }]);
  });

  it("disposes idempotently", () => {
    const events = new TerminalProcessEmitter();

    events.dispose();
    events.dispose();

    expect(() => events.onData(() => undefined)).toThrow(/disposed/);
  });
});
