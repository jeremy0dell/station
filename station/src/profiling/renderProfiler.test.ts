import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRenderProfiler,
  createRenderProfilerSession,
  readRenderProfileEnabled,
  resolveRenderProfilePath,
} from "./renderProfiler.js";

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

describe("resolveRenderProfilePath", () => {
  it("uses the worktree fallback when no override is provided", () => {
    expect(resolveRenderProfilePath(undefined, "/tmp/station-renders.jsonl")).toBe(
      "/tmp/station-renders.jsonl",
    );
    expect(resolveRenderProfilePath("", "/tmp/station-renders.jsonl")).toBe(
      "/tmp/station-renders.jsonl",
    );
  });

  it("requires an absolute explicit destination", () => {
    expect(() => resolveRenderProfilePath("relative.jsonl", "/tmp/fallback.jsonl")).toThrow(
      /absolute/,
    );
    expect(() => resolveRenderProfilePath(undefined, "relative.jsonl")).toThrow(/absolute/);
  });
});

describe("createRenderProfilerSession", () => {
  it("rejects an invalid sampling interval before creating a profile file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "station-prof-session-invalid-")), "renders.jsonl");
    expect(() =>
      createRenderProfilerSession(path, { getStats: () => ({}) }, { sampleIntervalMs: -1 }),
    ).toThrow(/non-negative/);
  });

  it("records bounded renderer statistics and disposes its interval", () => {
    const path = join(mkdtempSync(join(tmpdir(), "station-prof-session-")), "renders.jsonl");
    let calls = 0;
    const session = createRenderProfilerSession(
      path,
      {
        getStats: () => {
          calls += 1;
          return {
            fps: 60,
            frameCount: calls,
            frameTimes: [1, 2, 3],
            nativeStats: { gpuMemory: 7 },
            ignored: "not recorded",
          };
        },
      },
      { sampleIntervalMs: 0 },
    );

    session.onRender("station", "update", 1.234, 2, 0, 12.5);
    session.sampleNow();
    session.dispose();
    session.dispose();

    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.event)).toEqual([
      "session-start",
      "renderer-sample",
      "commit",
      "renderer-sample",
      "session-end",
    ]);
    expect(lines[1]).toMatchObject({
      fps: 60,
      frameCount: 1,
      frameTimesCount: 3,
      frameTimeSumMs: 6,
      nativeStats: { gpuMemory: 7 },
    });
    expect(lines[1]).not.toHaveProperty("ignored");
    expect(calls).toBe(2);
  });
});
