import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReconcileScheduler,
  type ReconcileReadiness,
} from "../../src/runtime/reconcileScheduler";

describe("reconcile scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("advances an ordinary pending flush for ready interactive work", async () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    const scheduler = createReconcileScheduler({
      debounceMs: 100,
      interactiveDebounceMs: 25,
      reconcile: async (reason) => {
        reasons.push(reason);
      },
    });

    scheduler.request("hook:codex:Stop");
    await vi.advanceTimersByTimeAsync(10);
    scheduler.requestInteractive("agent.prepareExternalLaunch");
    await vi.advanceTimersByTimeAsync(24);
    expect(reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(reasons).toEqual(["scheduled:batch(2)"]);
  });

  it("uses the interactive delay for ready work queued behind a running reconcile", async () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    const firstReconcile = deferred<void>();
    const firstStarted = deferred<void>();
    const scheduler = createReconcileScheduler({
      debounceMs: 100,
      backlogDebounceMs: 1000,
      interactiveDebounceMs: 25,
      reconcile: async (reason) => {
        reasons.push(reason);
        if (reasons.length === 1) {
          firstStarted.resolve();
          await firstReconcile.promise;
        }
      },
    });

    scheduler.requestInteractive("agent.prepareExternalLaunch:first");
    await vi.advanceTimersByTimeAsync(25);
    await firstStarted.promise;
    scheduler.request("hook:codex:Stop");
    scheduler.requestInteractive("agent.prepareExternalLaunch:second");
    firstReconcile.resolve();
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(24);
    expect(reasons).toEqual(["agent.prepareExternalLaunch:first"]);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(reasons).toEqual(["agent.prepareExternalLaunch:first", "scheduled:batch(2)"]);
  });

  it("rechecks readiness at flush and defers an invalidated request", async () => {
    vi.useFakeTimers();
    const gate = readinessGate(true);
    const reasons: string[] = [];
    const scheduler = createReconcileScheduler({
      debounceMs: 100,
      reconcile: async (reason) => {
        reasons.push(reason);
      },
    });

    scheduler.requestWhenReady("agent.prepareExternalLaunch", gate.readiness);
    await vi.advanceTimersByTimeAsync(50);
    gate.block();
    await vi.advanceTimersByTimeAsync(50);
    await drainMicrotasks();
    expect(reasons).toEqual([]);

    gate.release();
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(99);
    expect(reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(reasons).toEqual(["agent.prepareExternalLaunch"]);
  });

  it("runs ready ordinary work without consuming blocked verification", async () => {
    vi.useFakeTimers();
    const gate = readinessGate(false);
    const reasons: string[] = [];
    const scheduler = createReconcileScheduler({
      debounceMs: 10,
      backlogDebounceMs: 10,
      reconcile: async (reason) => {
        reasons.push(reason);
      },
    });

    scheduler.requestWhenReady("agent.prepareExternalLaunch", gate.readiness);
    scheduler.request("hook:codex:Stop");
    await vi.advanceTimersByTimeAsync(10);
    await drainMicrotasks();
    expect(reasons).toEqual(["hook:codex:Stop"]);

    gate.release();
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await drainMicrotasks();
    expect(reasons).toEqual(["hook:codex:Stop", "agent.prepareExternalLaunch"]);
  });

  it("coalesces repeated verification requests into one ready wave", async () => {
    vi.useFakeTimers();
    const gate = readinessGate(false);
    const reasons: string[] = [];
    const scheduler = createReconcileScheduler({
      debounceMs: 10,
      reconcile: async (reason) => {
        reasons.push(reason);
      },
    });

    for (let index = 0; index < 20; index += 1) {
      scheduler.requestWhenReady("agent.prepareExternalLaunch", gate.readiness);
    }
    gate.release();
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await drainMicrotasks();

    expect(reasons).toEqual(["agent.prepareExternalLaunch"]);
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

function readinessGate(initiallyReady: boolean): {
  readiness: ReconcileReadiness;
  block(): void;
  release(): void;
} {
  let ready = initiallyReady;
  let idle = deferred<void>();
  return {
    readiness: {
      isReady: () => ready,
      whenReady: () => (ready ? Promise.resolve() : idle.promise),
    },
    block: () => {
      if (!ready) return;
      ready = false;
      idle = deferred<void>();
    },
    release: () => {
      ready = true;
      idle.resolve();
    },
  };
}
