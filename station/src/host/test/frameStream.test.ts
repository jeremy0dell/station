import { describe, expect, it } from "bun:test";
import { createFrameStream } from "../frameStream.js";

describe("Host attachment frame stream", () => {
  it("preserves ordered Unicode data and resize frames before ending", async () => {
    const stream = createFrameStream(() => {});
    const frames = [
      { type: "data", ptyId: "pty-1", data: "🎹\u001b[200~paste\u001b[201~" },
      { type: "resize", ptyId: "pty-1", cols: 120, rows: 40 },
    ] as const;
    for (const frame of frames) stream.push(frame);
    stream.end();
    const result = [];
    for await (const frame of stream.frames) result.push(frame);
    expect(result).toEqual(frames);
  });

  it("disconnects a stalled receiver and releases ownership exactly once", async () => {
    let releases = 0;
    const stream = createFrameStream(() => { releases++; stream.end(); });
    const iterator = stream.frames[Symbol.asyncIterator]();
    for (let index = 0; index < 40; index++) {
      stream.push({ type: "data", ptyId: "pty-1", data: "x".repeat(32 * 1024) });
    }
    expect(releases).toBe(1);
    await expect(iterator.next()).rejects.toMatchObject({ message: "Host attachment output exceeded 1 MiB; reconnect to recover terminal history." });
    await iterator.return?.();
    expect(releases).toBe(1);
  });

  it("reclaims the budget as frames are consumed", async () => {
    const stream = createFrameStream(() => { throw new Error("unexpected detach"); });
    const iterator = stream.frames[Symbol.asyncIterator]();
    for (let index = 0; index < 100; index++) {
      const next = iterator.next();
      stream.push({ type: "data", ptyId: "pty-1", data: "x".repeat(32 * 1024) });
      expect((await next).done).toBe(false);
    }
    stream.end();
    expect((await iterator.next()).done).toBe(true);
  });

  it("settles pending pulls on return and ignores later pushes", async () => {
    const stream = createFrameStream(() => {});
    const iterator = stream.frames[Symbol.asyncIterator]();
    const pending = iterator.next();
    await iterator.return?.();
    expect((await pending).done).toBe(true);
    stream.push({ type: "focus", ptyId: "pty-1" });
    expect((await iterator.next()).done).toBe(true);
  });

  it("charges UTF-8 bytes and control frames against the bound", async () => {
    for (const data of ["🎹".repeat(256 * 1024), ""]) {
      let released = false;
      const stream = createFrameStream(() => { released = true; });
      for (let index = 0; index < 40_000 && !released; index++) {
        stream.push({ type: "data", ptyId: "pty-1", data });
      }
      expect(released).toBe(true);
      await expect(stream.frames[Symbol.asyncIterator]().next()).rejects.toMatchObject({ message: "Host attachment output exceeded 1 MiB; reconnect to recover terminal history." });
    }
  });
});
