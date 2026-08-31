import { EventEmitter } from "node:events";
import type { ChildProcessLike, SpawnStationHostInput } from "@station/terminal";
import { describe, expect, it, vi } from "vitest";
import { startStationHostProcess } from "../../src/host/hostProcess.js";

class FakeChild extends EventEmitter {
  pid: number | undefined = 42;
  readonly calls: string[] = [];
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
  unref(): this {
    this.calls.push("unref");
    return this;
  }
  override on(event: string, listener: (...args: never[]) => void): this {
    this.calls.push(`on:${event}`);
    return super.on(event, listener);
  }
  override off(event: string, listener: (...args: never[]) => void): this {
    this.calls.push(`off:${event}`);
    return super.off(event, listener);
  }
}

const spawnInput: SpawnStationHostInput = {
  argv: ["stn", "host", "serve"],
  spawnOptions: { detached: true, stdio: "ignore" },
};

function processFor(child: FakeChild, now: () => number = () => 100) {
  return startStationHostProcess(spawnInput, {
    spawnHost: () => child as unknown as ChildProcessLike,
    now,
  });
}

describe("direct Station Host child ownership", () => {
  it("subscribes to every terminal event before releasing the event-loop reference", () => {
    const child = new FakeChild();
    processFor(child);
    expect(child.calls.slice(0, 4)).toEqual(["on:error", "on:exit", "on:close", "unref"]);
  });

  it("transfers only to the unchanged singleton child PID before cutoff", () => {
    const exact = processFor(new FakeChild());
    expect(exact.transfer([42], 101)).toBe(true);
    expect(exact.transfer([999], 0)).toBe(true);

    expect(processFor(new FakeChild()).transfer([], 101)).toBe(false);
    expect(processFor(new FakeChild()).transfer([42, 43], 101)).toBe(false);
    expect(processFor(new FakeChild()).transfer([43], 101)).toBe(false);
    expect(processFor(new FakeChild()).transfer([42], 100)).toBe(false);

    const changedChild = new FakeChild();
    const changed = processFor(changedChild);
    changedChild.pid = 43;
    expect(changed.transfer([42], 101)).toBe(false);

    const invalidChild = new FakeChild();
    invalidChild.pid = 0;
    expect(processFor(invalidChild).transfer([0], 101)).toBe(false);
  });

  it("makes a failed transfer terminal", () => {
    const lease = processFor(new FakeChild());
    expect(lease.transfer([43], 101)).toBe(false);
    expect(lease.transfer([42], 101)).toBe(false);
  });

  it("treats error as transfer failure but waits for settlement during cleanup", async () => {
    const child = new FakeChild();
    const lease = processFor(child);
    child.emit("error", new Error("spawn failed"));
    expect(lease.transfer([42], 101)).toBe(false);

    const cleanup = lease.cleanup(1_000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", 1, null);
    await expect(cleanup).resolves.toBe(true);
  });

  it("does not signal a child that already settled, including at the deadline", async () => {
    let now = 999;
    const beforeChild = new FakeChild();
    const before = processFor(beforeChild, () => now);
    beforeChild.emit("close", 0, null);
    await expect(before.cleanup(1_000)).resolves.toBe(true);
    expect(beforeChild.kill).not.toHaveBeenCalled();

    now = 1_000;
    const atChild = new FakeChild();
    const at = processFor(atChild, () => now);
    atChild.emit("exit", 0, null);
    await expect(at.cleanup(1_000)).resolves.toBe(false);
    expect(atChild.kill).not.toHaveBeenCalled();
  });

  it("waits for invalid-PID settlement without signaling and never mutates after deadline", async () => {
    let now = 100;
    const invalidChild = new FakeChild();
    invalidChild.pid = undefined;
    const invalid = processFor(invalidChild, () => now);
    invalidChild.emit("error", new Error("spawn failed"));
    const pending = invalid.cleanup(1_000);
    expect(invalidChild.kill).not.toHaveBeenCalled();
    now = 200;
    invalidChild.emit("close", 1, null);
    await expect(pending).resolves.toBe(true);

    now = 1_000;
    const lateChild = new FakeChild();
    await expect(processFor(lateChild, () => now).cleanup(1_000)).resolves.toBe(false);
    expect(lateChild.kill).not.toHaveBeenCalled();
  });

  it("uses at most one TERM and one KILL within the fixed cleanup reserve", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const child = new FakeChild();
      const lease = processFor(child, () => now);
      const cleanup = lease.cleanup(2_000);
      expect(lease.cleanup(2_000)).toBe(cleanup);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);

      now = 1_500;
      await vi.advanceTimersByTimeAsync(1_500);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);

      now = 1_999;
      child.emit("close", 0, null);
      await expect(cleanup).resolves.toBe(true);
      expect(child.kill).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unproven settlement at the deadline without extra signaling", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const child = new FakeChild();
      const lease = processFor(child, () => now);
      const cleanup = lease.cleanup(2_000);
      now = 1_500;
      await vi.advanceTimersByTimeAsync(1_500);
      now = 2_000;
      child.emit("exit", 0, null);
      await expect(cleanup).resolves.toBe(false);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still settles and detaches when direct-child signaling throws", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const child = new FakeChild();
      child.kill.mockImplementation(() => {
        throw new Error("signal delivery uncertain");
      });
      const lease = processFor(child, () => now);
      const cleanup = lease.cleanup(2_000);

      now = 1_500;
      await vi.advanceTimersByTimeAsync(1_500);
      now = 2_000;
      await vi.advanceTimersByTimeAsync(500);

      await expect(cleanup).resolves.toBe(false);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(child.calls.filter((call) => call.startsWith("off:"))).toEqual([
        "off:error",
        "off:exit",
        "off:close",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
