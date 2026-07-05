import { afterEach, describe, expect, it, vi } from "vitest";
import { type ForcedExitDeps, runShutdownWithBackstop } from "../../src/runtime/gracefulExit.js";

function deps(exit: (code: number) => void): ForcedExitDeps {
  return {
    exit,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
  };
}

describe("runShutdownWithBackstop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-exits when a shutdown step hangs past the budget", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    // Never-resolving drain simulates a command handler that ignores its abort.
    void runShutdownWithBackstop(() => new Promise<void>(() => undefined), 5000, deps(exit));
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not force-exit when the drain completes in time", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    await runShutdownWithBackstop(() => Promise.resolve(), 5000, deps(exit));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).not.toHaveBeenCalled();
  });

  it("clears the backstop even if the drain rejects", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    await expect(
      runShutdownWithBackstop(() => Promise.reject(new Error("drain failed")), 5000, deps(exit)),
    ).rejects.toThrow("drain failed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).not.toHaveBeenCalled();
  });
});
