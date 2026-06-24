import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderProfiler, readRenderProfileEnabled } from "./renderProfiler.js";

describe("readRenderProfileEnabled", () => {
  it("treats unset/empty/0/false as off", () => {
    for (const value of [undefined, "", "0", "false"]) {
      expect(readRenderProfileEnabled(value)).toBe(false);
    }
  });

  it("treats 1/true as on", () => {
    expect(readRenderProfileEnabled("1")).toBe(true);
    expect(readRenderProfileEnabled("true")).toBe(true);
  });

  it("throws on an unsupported value rather than guessing", () => {
    expect(() => readRenderProfileEnabled("yes")).toThrow(/STATION_PROFILE/);
  });
});

describe("createRenderProfiler", () => {
  it("writes a session marker, then one rounded JSON line per commit", () => {
    const path = join(mkdtempSync(join(tmpdir(), "station-prof-")), "renders.jsonl");
    const onRender = createRenderProfiler(path);

    onRender("station", "update", 1.234, 2, 0, 12.5);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("session-start");
    expect(JSON.parse(lines[1])).toMatchObject({
      id: "station",
      phase: "update",
      actualMs: 1.23,
      atMs: 12.5,
    });
  });
});
