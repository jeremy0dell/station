import { describe, expect, it } from "vitest";
import { createWorktreeCreateCoordinator } from "../../src/worktreeCreateCoordinator";

describe("worktree create coordinator", () => {
  it("admits at most four provider creates per project in FIFO order", async () => {
    const coordinator = createWorktreeCreateCoordinator();
    const releases = Array.from({ length: 6 }, () => deferred<void>());
    const starts: number[] = [];
    const runs = releases.map((release, index) =>
      coordinator.run("web", `branch-${index}`, new AbortController().signal, (create) =>
        create(async () => {
          starts.push(index);
          await release.promise;
        }),
      ),
    );
    await drainMicrotasks();

    expect(starts).toEqual([0, 1, 2, 3]);
    releases[0]?.resolve();
    await drainMicrotasks();
    expect(starts).toEqual([0, 1, 2, 3, 4]);
    releases[1]?.resolve();
    await drainMicrotasks();
    expect(starts).toEqual([0, 1, 2, 3, 4, 5]);

    for (const release of releases) release.resolve();
    await Promise.all(runs);
  });

  it("keeps a same-branch lease through downstream rollback while another branch proceeds", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 2 });
    const rollback = deferred<void>();
    const starts: string[] = [];
    const first = coordinator.run("web", "shared", new AbortController().signal, async (create) => {
      await create(async () => {
        starts.push("session.create");
      });
      await rollback.promise;
      throw new Error("expected downstream failure");
    });
    const sameBranch = coordinator.run("web", "shared", new AbortController().signal, (create) =>
      create(async () => {
        starts.push("worktree.fork");
      }),
    );
    const otherBranch = coordinator.run("web", "other", new AbortController().signal, (create) =>
      create(async () => {
        starts.push("worktree.create");
      }),
    );
    await drainMicrotasks();

    expect(starts).toEqual(["session.create", "worktree.create"]);
    rollback.resolve();
    await expect(first).rejects.toThrow("expected downstream failure");
    await Promise.all([sameBranch, otherBranch]);
    expect(starts).toEqual(["session.create", "worktree.create", "worktree.fork"]);
  });

  it("removes a cancelled branch waiter without starting its transaction", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 1 });
    const rollback = deferred<void>();
    const starts: string[] = [];
    const first = coordinator.run("web", "shared", new AbortController().signal, async (create) => {
      await create(async () => {
        starts.push("first");
      });
      await rollback.promise;
    });
    const cancelled = new AbortController();
    const second = coordinator.run("web", "shared", cancelled.signal, (create) =>
      create(async () => {
        starts.push("cancelled");
      }),
    );
    const third = coordinator.run("web", "shared", new AbortController().signal, (create) =>
      create(async () => {
        starts.push("third");
      }),
    );
    await drainMicrotasks();

    cancelled.abort(new Error("cancel queued branch"));
    await expect(second).rejects.toThrow("cancel queued branch");
    rollback.resolve();
    await Promise.all([first, third]);
    expect(starts).toEqual(["first", "third"]);
  });

  it("removes a cancelled capacity waiter without consuming the next slot", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 1 });
    const firstRelease = deferred<void>();
    const starts: string[] = [];
    const first = coordinator.run("web", "first", new AbortController().signal, (create) =>
      create(async () => {
        starts.push("first");
        await firstRelease.promise;
      }),
    );
    const cancelled = new AbortController();
    const second = coordinator.run("web", "second", cancelled.signal, (create) =>
      create(async () => {
        starts.push("cancelled");
      }),
    );
    const third = coordinator.run("web", "third", new AbortController().signal, (create) =>
      create(async () => {
        starts.push("third");
      }),
    );
    await drainMicrotasks();

    cancelled.abort(new Error("cancel queued capacity"));
    await expect(second).rejects.toThrow("cancel queued capacity");
    firstRelease.resolve();
    await Promise.all([first, third]);
    expect(starts).toEqual(["first", "third"]);
  });

  it("releases provider capacity and branch ownership after failure", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 1 });
    const starts: string[] = [];
    const failed = coordinator.run("web", "shared", new AbortController().signal, (create) =>
      create(async () => {
        starts.push("failed");
        throw new Error("provider failed");
      }),
    );
    const following = coordinator.run("web", "shared", new AbortController().signal, (create) =>
      create(async () => {
        starts.push("following");
      }),
    );

    await expect(failed).rejects.toThrow("provider failed");
    await following;
    expect(starts).toEqual(["failed", "following"]);
  });

  it("releases provider capacity and branch ownership after active cancellation settles", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 1 });
    const controller = new AbortController();
    const starts: string[] = [];
    const cancelled = coordinator.run("web", "shared", controller.signal, (create) =>
      create(
        () =>
          new Promise<void>((_resolve, reject) => {
            starts.push("active");
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
              once: true,
            });
          }),
      ),
    );
    const following = coordinator.run("web", "shared", new AbortController().signal, (create) =>
      create(async () => {
        starts.push("following");
      }),
    );
    await drainMicrotasks();

    controller.abort(new Error("cancel active create"));
    await expect(cancelled).rejects.toThrow("cancel active create");
    await following;
    expect(starts).toEqual(["active", "following"]);
    expect(coordinator.isIdle()).toBe(true);
  });

  it("keeps different projects independent", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 1 });
    const webRelease = deferred<void>();
    const starts: string[] = [];
    const web = coordinator.run("web", "feature", new AbortController().signal, (create) =>
      create(async () => {
        starts.push("web");
        await webRelease.promise;
      }),
    );
    const api = coordinator.run("api", "feature", new AbortController().signal, (create) =>
      create(async () => {
        starts.push("api");
      }),
    );
    await drainMicrotasks();

    expect(starts).toEqual(["web", "api"]);
    webRelease.resolve();
    await Promise.all([web, api]);
  });

  it("reports project and global quiescence only after rollback and queued work settle", async () => {
    const coordinator = createWorktreeCreateCoordinator({ maxConcurrentPerProject: 1 });
    const rollback = deferred<void>();
    const web = coordinator.run("web", "feature", new AbortController().signal, async (create) => {
      await create(async () => undefined);
      await rollback.promise;
    });
    const api = coordinator.run("api", "feature", new AbortController().signal, (create) =>
      create(async () => undefined),
    );
    let webIdle = false;
    let allIdle = false;
    const projectIdle = coordinator.whenProjectIdle("web").then(() => {
      webIdle = true;
    });
    const idle = coordinator.whenIdle().then(() => {
      allIdle = true;
    });
    await api;
    await drainMicrotasks();

    expect(coordinator.isProjectIdle("api")).toBe(true);
    expect(coordinator.isProjectIdle("web")).toBe(false);
    expect(coordinator.isIdle()).toBe(false);
    expect(webIdle).toBe(false);
    expect(allIdle).toBe(false);

    rollback.resolve();
    await Promise.all([web, projectIdle, idle]);
    expect(webIdle).toBe(true);
    expect(allIdle).toBe(true);
    expect(coordinator.isIdle()).toBe(true);
  });

  it("rejects a second provider create call from one transaction", async () => {
    const coordinator = createWorktreeCreateCoordinator();
    await expect(
      coordinator.run("web", "feature", new AbortController().signal, async (create) => {
        await create(async () => undefined);
        await create(async () => undefined);
      }),
    ).rejects.toThrow("exactly one provider create");
    expect(coordinator.isIdle()).toBe(true);
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
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
