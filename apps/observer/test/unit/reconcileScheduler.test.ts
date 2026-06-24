import { describe, expect, it } from "vitest";
import { createReconcileScheduler } from "../../src/runtime/reconcileScheduler";

describe("reconcile scheduler", () => {
  it("coalesces a burst of hook reconcile requests", async () => {
    const reasons: string[] = [];
    const scheduler = createReconcileScheduler({
      debounceMs: 0,
      reconcile: async (reason) => {
        reasons.push(reason);
      },
    });

    scheduler.request("hook:codex:PreToolUse");
    scheduler.request("hook:codex:PostToolUse");
    scheduler.request("hook:codex:Stop");
    await drainMicrotasks();

    expect(reasons).toEqual(["hook:batch(3)"]);
  });

  it("runs one follow-up reconcile for requests that arrive while reconcile is running", async () => {
    const reasons: string[] = [];
    const firstReconcile = deferred<void>();
    const firstStarted = deferred<void>();
    const scheduler = createReconcileScheduler({
      debounceMs: 0,
      backlogDebounceMs: 0,
      reconcile: async (reason) => {
        reasons.push(reason);
        if (reasons.length === 1) {
          firstStarted.resolve();
          await firstReconcile.promise;
        }
      },
    });

    scheduler.request("hook:codex:PreToolUse");
    await firstStarted.promise;
    scheduler.request("hook:codex:PostToolUse");
    scheduler.request("hook:codex:Stop");
    firstReconcile.resolve();
    await drainMicrotasks();

    expect(reasons).toEqual(["hook:codex:PreToolUse", "hook:batch(2)"]);
  });

  it("reports flush profile metrics", async () => {
    const profiles: unknown[] = [];
    const scheduler = createReconcileScheduler({
      debounceMs: 0,
      reconcile: async () => undefined,
      onFlushFinish: (profile) => {
        profiles.push(profile);
      },
    });

    scheduler.request("hook:codex:PreToolUse");
    scheduler.request("hook:codex:PostToolUse");
    await drainMicrotasks();

    expect(profiles).toEqual([
      expect.objectContaining({
        reason: "hook:batch(2)",
        queuedCount: 2,
        queuedAfter: 0,
      }),
    ]);
  });

  it("reports queued requests that arrive while a reconcile is running", async () => {
    const profiles: unknown[] = [];
    const firstReconcile = deferred<void>();
    const firstStarted = deferred<void>();
    const scheduler = createReconcileScheduler({
      debounceMs: 0,
      backlogDebounceMs: 0,
      reconcile: async () => {
        if (profiles.length === 0) {
          firstStarted.resolve();
          await firstReconcile.promise;
        }
      },
      onFlushFinish: (profile) => {
        profiles.push(profile);
      },
    });

    scheduler.request("hook:codex:PreToolUse");
    await firstStarted.promise;
    scheduler.request("hook:codex:PostToolUse");
    scheduler.request("hook:codex:Stop");
    firstReconcile.resolve();
    await drainMicrotasks();

    expect(profiles).toEqual([
      expect.objectContaining({
        reason: "hook:codex:PreToolUse",
        queuedCount: 1,
        queuedWhileRunning: 2,
        queuedAfter: 2,
      }),
      expect.objectContaining({
        reason: "hook:batch(2)",
        queuedCount: 2,
        queuedWhileRunning: 0,
        queuedAfter: 0,
      }),
    ]);
  });

  it("waits for a backlog quiet period before follow-up reconcile", async () => {
    const reasons: string[] = [];
    const firstReconcile = deferred<void>();
    const firstStarted = deferred<void>();
    const scheduler = createReconcileScheduler({
      debounceMs: 0,
      backlogDebounceMs: 20,
      reconcile: async (reason) => {
        reasons.push(reason);
        if (reasons.length === 1) {
          firstStarted.resolve();
          await firstReconcile.promise;
        }
      },
    });

    scheduler.request("hook:opencode:message.part.delta");
    await firstStarted.promise;
    scheduler.request("hook:opencode:message.part.delta");
    firstReconcile.resolve();
    await drainMicrotasks();

    expect(reasons).toEqual(["hook:opencode:message.part.delta"]);

    await sleep(30);
    await drainMicrotasks();

    expect(reasons).toEqual([
      "hook:opencode:message.part.delta",
      "hook:opencode:message.part.delta",
    ]);
  });
});

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
