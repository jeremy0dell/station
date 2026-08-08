import { describe, expect, it } from "bun:test";
import {
  createJsonLineFeed,
  parseBridgeLine,
  toTerminalExit,
} from "./ptyBridgeChannel.js";

describe("createJsonLineFeed", () => {
  it("emits one line per newline-delimited frame", () => {
    const lines: string[] = [];
    const feed = createJsonLineFeed((line) => lines.push(line));
    feed('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("retains a partial line until its newline arrives", () => {
    const lines: string[] = [];
    const feed = createJsonLineFeed((line) => lines.push(line));
    feed('{"a"');
    feed(":1");
    expect(lines).toEqual([]);
    feed("}\n");
    expect(lines).toEqual(['{"a":1}']);
  });

  it("splits frames across chunk boundaries", () => {
    const lines: string[] = [];
    const feed = createJsonLineFeed((line) => lines.push(line));
    feed('{"a":1}\n{"b"');
    feed(':2}\n{"c":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe("parseBridgeLine", () => {
  it("parses a JSON line", () => {
    const message = parseBridgeLine<{ type: string }>('{"type":"data"}', () => {});
    expect(message).toEqual({ type: "data" });
  });

  it("degrades an unparseable line to a truncated diagnostic and continues", () => {
    const diagnostics: string[] = [];
    const message = parseBridgeLine("not json", (m) => diagnostics.push(m));
    expect(message).toBeUndefined();
    expect(diagnostics).toEqual(["unparseable bridge line: not json"]);
  });

  it("truncates the diagnostic for long garbage lines", () => {
    const diagnostics: string[] = [];
    parseBridgeLine("x".repeat(500), (m) => diagnostics.push(m));
    expect(diagnostics[0]).toBe(`unparseable bridge line: ${"x".repeat(200)}`);
  });
});

describe("toTerminalExit", () => {
  it("keeps signal absent when the PTY exited by code", () => {
    const event = toTerminalExit(0);
    expect(event).toEqual({ exitCode: 0 });
    expect("signal" in event).toBe(false);
  });

  it("carries the signal when present", () => {
    expect(toTerminalExit(1, 15)).toEqual({ exitCode: 1, signal: 15 });
  });
});
