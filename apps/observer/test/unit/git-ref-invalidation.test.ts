import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalGitWorktreeMetadataInvalidationSource,
  gitRefInvalidationTargetsForWorktree,
} from "../../src/metadata/gitRefInvalidation.js";
import type { WorktreeMetadataTarget } from "../../src/metadata/ports.js";
import type { StationLogger } from "../../src/stationLogger.js";

const target: WorktreeMetadataTarget = {
  worktreeId: "wt_1",
  projectId: "web",
  branch: "main",
  registrationIdentity: "registration-1",
};

describe("local Git worktree metadata invalidation", () => {
  it("resolves linked-worktree Git ref targets", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "station-git-ref-invalidation-"));
    try {
      const worktree = join(tempDir, "worktree");
      const commonGitDir = join(tempDir, "repo", ".git");
      const gitDir = join(commonGitDir, "worktrees", "pr-info-1");
      await mkdir(worktree, { recursive: true });
      await mkdir(gitDir, { recursive: true });
      await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
      await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/pr-info-1\n");
      await writeFile(join(gitDir, "commondir"), "../..\n");

      const targets = gitRefInvalidationTargetsForWorktree(worktree, "pr-info-1").map(
        (entry) => entry.path,
      );

      expect(targets).toContain(join(worktree, ".git"));
      expect(targets).toContain(join(gitDir, "HEAD"));
      expect(targets).toContain(join(commonGitDir, "refs/heads/pr-info-1"));
      expect(targets).toContain(join(commonGitDir, "packed-refs"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retains identical registrations and reconciles branch ref notifications", async () => {
    const fixture = await createWatchFixture();
    try {
      await fixture.source.replaceWatchedWorktrees([target]);
      const watchCount = fixture.watches.length;
      await fixture.source.replaceWatchedWorktrees([target]);

      expect(fixture.watches).toHaveLength(watchCount);
      for (const [index, changedFile] of [".git", "HEAD", "main", "packed-refs"].entries()) {
        fixture.watches[index]?.listener(changedFile);
        await waitFor(() => fixture.reasons.length === index + 1);
      }
      expect(fixture.reasons).toEqual(Array(4).fill("metadata:git-ref:wt_1"));
    } finally {
      await fixture.source.shutdown();
      await fixture.cleanup();
    }
  });

  it("invalidates stale callbacks and timers when an identity is replaced", async () => {
    const fixture = await createWatchFixture();
    try {
      await fixture.source.replaceWatchedWorktrees([target]);
      const oldWatches = [...fixture.watches];
      const oldBranchWatch = fixture.branchWatch();
      oldBranchWatch?.listener("main");

      const replacement = { ...target, registrationIdentity: "registration-2" };
      fixture.registrationIdentity = "registration-2";
      await fixture.source.replaceWatchedWorktrees([replacement]);

      expect(oldWatches.every((watch) => watch.closed === 1)).toBe(true);
      oldBranchWatch?.listener("main");
      await delay(30);
      expect(fixture.reasons).toEqual([]);

      const replacementWatches = fixture.watches.slice(oldWatches.length);
      fixture.branchWatch(oldWatches.length)?.listener("main");
      await waitFor(() => fixture.reasons.length === 1);
      expect(fixture.reasons).toEqual(["metadata:git-ref:wt_1"]);

      await fixture.source.replaceWatchedWorktrees([]);
      expect(replacementWatches.every((watch) => watch.closed === 1)).toBe(true);
      expect(oldWatches.every((watch) => watch.closed === 1)).toBe(true);
    } finally {
      await fixture.source.shutdown();
      await fixture.cleanup();
    }
  });

  it("makes shutdown terminal and attempts every close when one throws", async () => {
    const fixture = await createWatchFixture({ throwingCloseIndex: 0 });
    await fixture.source.replaceWatchedWorktrees([target]);
    const activeWatches = [...fixture.watches];
    const staleCallback = fixture.branchWatch();

    await fixture.source.shutdown();
    await fixture.source.shutdown();
    await fixture.source.replaceWatchedWorktrees([target]);
    staleCallback?.listener("main");
    await delay(30);

    expect(activeWatches.every((watch) => watch.closed === 1)).toBe(true);
    expect(fixture.watches).toHaveLength(activeWatches.length);
    expect(fixture.reasons).toEqual([]);
    await fixture.cleanup();
  });

  it("logs watch-start failure and retries on the next replacement", async () => {
    const warnings: unknown[] = [];
    const fixture = await createWatchFixture({
      failStartCount: 1,
      logger: testLogger(async (_message, attributes) => void warnings.push(attributes)),
    });
    try {
      await fixture.source.replaceWatchedWorktrees([target]);
      const attemptsAfterFailure = fixture.startAttempts;
      await fixture.source.replaceWatchedWorktrees([target]);

      expect(attemptsAfterFailure).toBe(1);
      expect(fixture.startAttempts).toBeGreaterThan(attemptsAfterFailure);
      expect(warnings).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({ code: "LOCAL_GIT_REF_WATCH_FAILED" }),
        }),
      ]);
    } finally {
      await fixture.source.shutdown();
      await fixture.cleanup();
    }
  });

  it("removes a failed runtime registration and permits re-arm", async () => {
    const fixture = await createWatchFixture();
    try {
      await fixture.source.replaceWatchedWorktrees([target]);
      const firstGeneration = [...fixture.watches];
      firstGeneration[0]?.error?.(new Error("watch failed"));
      await fixture.source.replaceWatchedWorktrees([target]);

      expect(firstGeneration.every((watch) => watch.closed === 1)).toBe(true);
      expect(fixture.watches.length).toBeGreaterThan(firstGeneration.length);
    } finally {
      await fixture.source.shutdown();
      await fixture.cleanup();
    }
  });

  it("contains logger rejection during watcher failure cleanup", async () => {
    const fixture = await createWatchFixture({
      logger: testLogger(async () => {
        throw new Error("logger failed");
      }),
    });
    try {
      await fixture.source.replaceWatchedWorktrees([target]);
      fixture.watches[0]?.error?.(new Error("watch failed"));
      await settleAsyncFailures();
      await expect(fixture.source.replaceWatchedWorktrees([target])).resolves.toBeUndefined();
    } finally {
      await fixture.source.shutdown();
      await fixture.cleanup();
    }
  });
});

type FakeWatch = {
  directory: string;
  listener: (changedFile: string | undefined) => void;
  error?: (error: Error) => void;
  closed: number;
};

async function createWatchFixture(
  options: { failStartCount?: number; throwingCloseIndex?: number; logger?: StationLogger } = {},
) {
  const tempDir = await mkdtemp(join(tmpdir(), "station-git-ref-invalidation-"));
  const worktree = join(tempDir, "worktree");
  const refDir = join(worktree, ".git", "refs", "heads");
  await mkdir(refDir, { recursive: true });
  await writeFile(join(worktree, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(refDir, "main"), "one\n");

  const watches: FakeWatch[] = [];
  const reasons: string[] = [];
  let startAttempts = 0;
  let registrationIdentity = target.registrationIdentity;
  let remainingStartFailures = options.failStartCount ?? 0;
  const sourceOptions: Parameters<typeof createLocalGitWorktreeMetadataInvalidationSource>[0] = {
    debounceMs: 10,
    resolveWorktree: (expected) => ({
      worktreeId: expected.worktreeId,
      projectId: expected.projectId,
      branch: expected.branch,
      path: worktree,
      ...(registrationIdentity === undefined ? {} : { registrationIdentity }),
    }),
    requestReconcile: (reason) => void reasons.push(reason),
    watchDirectory: (directory, listener) => {
      startAttempts += 1;
      if (remainingStartFailures > 0) {
        remainingStartFailures -= 1;
        throw new Error("watch start failed");
      }
      const index = watches.length;
      const entry: FakeWatch = { directory, listener, closed: 0 };
      watches.push(entry);
      return {
        close: () => {
          entry.closed += 1;
          if (index === options.throwingCloseIndex) throw new Error("close failed");
        },
        on: (_event, error) => {
          entry.error = error;
        },
      };
    },
  };
  if (options.logger !== undefined) sourceOptions.logger = options.logger;
  const source = createLocalGitWorktreeMetadataInvalidationSource(sourceOptions);

  return {
    source,
    watches,
    reasons,
    get startAttempts() {
      return startAttempts;
    },
    get registrationIdentity() {
      return registrationIdentity;
    },
    set registrationIdentity(value: string | undefined) {
      registrationIdentity = value;
    },
    branchWatch(offset = 0) {
      return watches.slice(offset).find((entry) => entry.directory === refDir);
    },
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

function testLogger(warn: StationLogger["warn"]): StationLogger {
  return {
    info: async () => undefined,
    warn,
    error: async () => undefined,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for condition.");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleAsyncFailures(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
