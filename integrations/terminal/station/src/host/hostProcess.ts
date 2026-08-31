import { spawn } from "node:child_process";
import type { ChildProcessLike, SpawnStationHostInput } from "./ensureHostRunning.js";

/**
 * ADAPTER
 *
 * Retains one exact child. It performs no probe/lookup; transfer consumes proved holders and
 * cleanup signals only that retained child.
 */
export function startStationHostProcess(
  input: SpawnStationHostInput,
  deps: { spawnHost?: (input: SpawnStationHostInput) => ChildProcessLike; now?: () => number } = {},
) {
  const now = deps.now ?? Date.now;
  const [command, ...args] = input.argv;
  const child = deps.spawnHost?.(input) ?? spawn(command, args, input.spawnOptions);
  const pid = child.pid;
  let phase: "owned" | "failed" | "transferred" = "owned";
  let settledAt: number | undefined;
  let wake: (() => void) | undefined;
  let cleanupPromise: Promise<boolean> | undefined;
  const onError = () => {
    if (phase === "owned") phase = "failed";
  };
  const onSettled = () => {
    settledAt ??= now();
    wake?.();
  };
  child.on("error", onError);
  child.on("exit", onSettled);
  child.on("close", onSettled);
  child.unref();

  const detach = () => {
    child.off("error", onError);
    child.off("exit", onSettled);
    child.off("close", onSettled);
  };
  const settledBefore = (deadlineMs: number) => settledAt !== undefined && settledAt < deadlineMs;
  const waitUntil = (deadlineMs: number): Promise<void> => {
    if (settledAt !== undefined) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
      wake = finish;
      const timer = setTimeout(finish, Math.max(0, deadlineMs - now()));
    });
  };
  const validPid = () =>
    Number.isSafeInteger(pid) && pid !== undefined && pid > 0 && child.pid === pid;
  const signal = (name: NodeJS.Signals) => {
    try {
      child.kill(name);
    } catch {
      // Settlement, not signal delivery, is the ownership proof.
    }
  };
  const cleanup = async (deadlineMs: number) => {
    if (phase === "transferred") return true;
    phase = "failed";
    if (settledAt === undefined && now() < deadlineMs) {
      if (validPid()) {
        signal("SIGTERM");
        await waitUntil(Math.min(now() + 1_500, deadlineMs - 500));
        if (settledAt === undefined && now() < deadlineMs && validPid()) {
          signal("SIGKILL");
          await waitUntil(deadlineMs);
        }
      } else {
        await waitUntil(deadlineMs);
      }
    }
    const settled = settledBefore(deadlineMs);
    detach();
    return settled;
  };

  return {
    transfer(holderPids: readonly number[], cutoffMs: number) {
      if (phase === "transferred") return true;
      if (
        phase !== "owned" ||
        now() >= cutoffMs ||
        settledAt !== undefined ||
        !validPid() ||
        holderPids.length !== 1 ||
        holderPids[0] !== pid
      ) {
        phase = "failed";
        return false;
      }
      phase = "transferred";
      detach();
      return true;
    },
    cleanup: (deadlineMs: number) => (cleanupPromise ??= cleanup(deadlineMs)),
  };
}
