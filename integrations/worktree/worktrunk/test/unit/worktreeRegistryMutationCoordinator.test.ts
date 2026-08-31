import { describe, expect, it } from "vitest";
import { createWorktreeRegistryMutationCoordinator } from "../../src/worktreeRegistryMutationCoordinator.js";

describe("Worktree registry mutation coordinator", () => {
  it("keeps normal attempts concurrent", async () => {
    const coordinator = createWorktreeRegistryMutationCoordinator();
    const saturated = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = 0;
    let maxActive = 0;
    const attempt = async (value: string): Promise<string> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) saturated.resolve();
      await release.promise;
      active -= 1;
      return value;
    };

    const first = coordinator.runCreate(
      "web",
      () => attempt("first"),
      () => false,
      attempt,
    );
    const second = coordinator.runCreate(
      "web",
      () => attempt("second"),
      () => false,
      attempt,
    );
    await saturated.promise;
    release.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(maxActive).toBe(2);
  });

  it("drains older attempts and blocks newer admission around exact recovery", async () => {
    const coordinator = createWorktreeRegistryMutationCoordinator();
    const olderStarted = Promise.withResolvers<void>();
    const releaseOlder = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    const recoveryStarted = Promise.withResolvers<void>();
    const releaseRecovery = Promise.withResolvers<void>();
    const events: string[] = [];
    const registryRace = new Error("registry race");

    const older = coordinator.runCreate(
      "web",
      async () => {
        events.push("attempt:older");
        olderStarted.resolve();
        await releaseOlder.promise;
        events.push("settled:older");
        return "older";
      },
      (error) => error === registryRace,
      async () => "unused",
    );
    const raced = coordinator.runCreate(
      "web",
      async () => {
        await olderStarted.promise;
        events.push("attempt:raced");
        failed.resolve();
        throw registryRace;
      },
      (error) => error === registryRace,
      async () => {
        events.push("recovery:raced");
        recoveryStarted.resolve();
        await releaseRecovery.promise;
        return "recovered";
      },
    );
    await failed.promise;
    await Promise.resolve();
    await Promise.resolve();
    const newer = coordinator.runCreate(
      "web",
      async () => {
        events.push("attempt:newer");
        return "newer";
      },
      () => false,
      async () => "unused",
    );

    expect(events).toEqual(["attempt:older", "attempt:raced"]);
    releaseOlder.resolve();
    await recoveryStarted.promise;
    expect(events).toEqual(["attempt:older", "attempt:raced", "settled:older", "recovery:raced"]);
    releaseRecovery.resolve();

    await expect(Promise.all([older, raced, newer])).resolves.toEqual([
      "older",
      "recovered",
      "newer",
    ]);
    expect(events).toEqual([
      "attempt:older",
      "attempt:raced",
      "settled:older",
      "recovery:raced",
      "attempt:newer",
    ]);
  });

  it("drains creates before an exclusive registry operation and blocks newer creates", async () => {
    const coordinator = createWorktreeRegistryMutationCoordinator();
    const createStarted = Promise.withResolvers<void>();
    const releaseCreate = Promise.withResolvers<void>();
    const releaseExclusive = Promise.withResolvers<void>();
    const events: string[] = [];
    const active = coordinator.runCreate(
      "web",
      async () => {
        events.push("create:active");
        createStarted.resolve();
        await releaseCreate.promise;
        events.push("create:settled");
      },
      () => false,
      async () => undefined,
    );
    await createStarted.promise;
    const exclusive = coordinator.runExclusive("web", async () => {
      events.push("exclusive");
      await releaseExclusive.promise;
    });
    const newer = coordinator.runCreate(
      "web",
      async () => {
        events.push("create:newer");
      },
      () => false,
      async () => undefined,
    );

    expect(events).toEqual(["create:active"]);
    releaseCreate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["create:active", "create:settled", "exclusive"]);
    releaseExclusive.resolve();

    await Promise.all([active, exclusive, newer]);
    expect(events).toEqual(["create:active", "create:settled", "exclusive", "create:newer"]);
  });
});
