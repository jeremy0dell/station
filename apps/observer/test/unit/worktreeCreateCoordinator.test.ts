import { describe, expect, it } from "vitest";
import { createWorktreeCreateCoordinator } from "../../src/worktreeCreateCoordinator";

describe("worktree create coordinator", () => {
  it("bounds one project's active creates and admits waiters in FIFO order", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 2 });
    const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
    const starts: number[] = [];
    const runs = releases.map((release, index) =>
      coordinator.run("web", new AbortController().signal, async () => {
        starts.push(index);
        await release.promise;
      }),
    );
    await drainMicrotasks();

    expect(starts).toEqual([0, 1]);
    releases[0]?.resolve();
    await drainMicrotasks();
    expect(starts).toEqual([0, 1, 2]);

    releases[1]?.resolve();
    releases[2]?.resolve();
    await Promise.all(runs);
  });

  it("removes an aborted waiter without consuming a later slot", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 1 });
    const firstRelease = deferred<void>();
    const starts: string[] = [];
    const first = coordinator.run("web", new AbortController().signal, async () => {
      starts.push("first");
      await firstRelease.promise;
    });
    const cancelled = new AbortController();
    const second = coordinator.run("web", cancelled.signal, async () => {
      starts.push("cancelled");
    });
    const third = coordinator.run("web", new AbortController().signal, async () => {
      starts.push("third");
    });
    await drainMicrotasks();

    cancelled.abort(new Error("cancel queued create"));
    await expect(second).rejects.toThrow("cancel queued create");
    firstRelease.resolve();
    await Promise.all([first, third]);

    expect(starts).toEqual(["first", "third"]);
  });

  it("releases a failed create and keeps different projects independent", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 1 });
    const webRelease = deferred<void>();
    const starts: string[] = [];
    const web = coordinator.run("web", new AbortController().signal, async () => {
      starts.push("web");
      await webRelease.promise;
    });
    const api = coordinator.run("api", new AbortController().signal, async () => {
      starts.push("api");
      throw new Error("expected create failure");
    });
    await expect(api).rejects.toThrow("expected create failure");
    webRelease.resolve();
    await web;

    expect(starts).toEqual(["web", "api"]);
  });

  it("reports project idle only after active and queued creates drain", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 1 });
    const firstRelease = deferred<void>();
    const secondRelease = deferred<void>();
    const starts: string[] = [];
    const first = coordinator.run("web", new AbortController().signal, async () => {
      starts.push("first");
      await firstRelease.promise;
    });
    const second = coordinator.run("web", new AbortController().signal, async () => {
      starts.push("second");
      await secondRelease.promise;
    });
    let idle = false;
    const projectIdle = coordinator.whenProjectIdle("web").then(() => {
      idle = true;
    });
    await drainMicrotasks();

    expect(starts).toEqual(["first"]);
    expect(idle).toBe(false);
    firstRelease.resolve();
    await drainMicrotasks();
    expect(starts).toEqual(["first", "second"]);
    expect(idle).toBe(false);

    secondRelease.resolve();
    await Promise.all([first, second, projectIdle]);
    expect(idle).toBe(true);
    await expect(coordinator.whenProjectIdle("api")).resolves.toBeUndefined();
  });

  it("reports global idle only after every project's creates drain", async () => {
    const coordinator = createWorktreeCreateCoordinator();
    const webRelease = deferred<void>();
    const apiRelease = deferred<void>();
    const web = coordinator.run("web", new AbortController().signal, () => webRelease.promise);
    const api = coordinator.run("api", new AbortController().signal, () => apiRelease.promise);
    let allIdle = false;
    const idle = coordinator.whenIdle().then(() => {
      allIdle = true;
    });
    await drainMicrotasks();

    webRelease.resolve();
    await web;
    await drainMicrotasks();
    expect(allIdle).toBe(false);
    await expect(coordinator.whenProjectIdle("web")).resolves.toBeUndefined();

    apiRelease.resolve();
    await Promise.all([api, idle]);
    expect(allIdle).toBe(true);
    await expect(coordinator.whenIdle()).resolves.toBeUndefined();
  });
});

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
