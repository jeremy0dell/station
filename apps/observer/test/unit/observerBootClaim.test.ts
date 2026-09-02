import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listenUnixSocket } from "@station/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createObserverStartupGate, runObserverMain } from "../../src/runtime/main.js";
import {
  acquireObserverBootClaim,
  createObserverReapExclusion,
  observerBootClaimPath,
} from "../../src/runtime/observerBootClaim.js";
import type { SqlDatabase } from "../../src/sqlite/driver.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("observer boot claim", () => {
  it("derives a socket-relative path with private directory and database modes", async () => {
    const root = await tempRoot("station observer claim ");
    const socketPath = join(root, "runtime with spaces", "custom observer.sock");
    const path = join(dirname(socketPath), "observer.claim.sqlite");

    const claim = await acquireObserverBootClaim({ socketPath, timeoutMs: 100 });
    expect(claim.status).toBe("acquired");
    if (claim.status !== "acquired") return;
    try {
      expect(observerBootClaimPath(socketPath)).toBe(path);
      expect(claim.path).toBe(path);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(path)).isFile()).toBe(true);
    } finally {
      expect(claim.release()).toEqual({ status: "released" });
    }
  });

  it("bounds contention, then releases and reacquires without replacing the database", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const first = await acquireObserverBootClaim({ socketPath, timeoutMs: 500 });
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;
    const inode = (await stat(first.path)).ino;

    try {
      const startedAt = Date.now();
      const second = await acquireObserverBootClaim({ socketPath, timeoutMs: 75 });
      const elapsedMs = Date.now() - startedAt;
      expect(second).toMatchObject({
        status: "contended",
        error: { code: "OBSERVER_BOOT_CLAIM_CONTENDED" },
      });
      if (second.status === "contended") {
        expect(second.error).toBeInstanceOf(Error);
      }
      expect(elapsedMs).toBeGreaterThanOrEqual(40);
      expect(elapsedMs).toBeLessThan(2_000);
    } finally {
      const released = first.release();
      expect(first.release()).toBe(released);
      expect(released).toEqual({ status: "released" });
    }

    const successor = await acquireObserverBootClaim({ socketPath, timeoutMs: 100 });
    expect(successor.status).toBe("acquired");
    if (successor.status !== "acquired") return;
    expect((await stat(successor.path)).ino).toBe(inode);
    expect(successor.release()).toEqual({ status: "released" });
  });

  it("refuses insecure existing claim paths without changing their modes", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const path = observerBootClaimPath(socketPath);
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      await writeFile(`${path}${suffix}`, "", { mode: 0o644 });
    }
    const originalUmask = process.umask();

    const claim = await acquireObserverBootClaim({ socketPath, timeoutMs: 100 });
    expect(claim).toMatchObject({
      status: "failed",
      error: { code: "OBSERVER_BOOT_CLAIM_FAILED" },
    });
    expect(process.umask()).toBe(originalUmask);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o755);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      expect((await stat(`${path}${suffix}`)).mode & 0o777).toBe(0o644);
    }
  });

  it.each([
    "",
    "-journal",
    "-wal",
    "-shm",
  ])("rejects a symlink at the claim%s path without replacing it", async (suffix) => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const path = observerBootClaimPath(socketPath);
    const target = join(root, `target${suffix || "-db"}`);
    await writeFile(target, "target", "utf8");
    if (suffix === "") await mkdir(dirname(path), { recursive: true });
    else await initializeClaimDatabase(socketPath);
    await symlink(target, `${path}${suffix}`);

    const claim = await acquireObserverBootClaim({ socketPath, timeoutMs: 50 });
    expect(claim).toMatchObject({
      status: "failed",
      error: { code: "OBSERVER_BOOT_CLAIM_FAILED" },
    });
    expect((await lstat(`${path}${suffix}`)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe("target");
  });

  it.each([
    "",
    "-journal",
    "-wal",
    "-shm",
  ])("rejects a directory at the claim%s path", async (suffix) => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const path = observerBootClaimPath(socketPath);
    if (suffix === "") await mkdir(dirname(path), { recursive: true });
    else await initializeClaimDatabase(socketPath);
    await mkdir(`${path}${suffix}`);

    const claim = await acquireObserverBootClaim({ socketPath, timeoutMs: 50 });
    expect(claim).toMatchObject({
      status: "failed",
      error: { code: "OBSERVER_BOOT_CLAIM_FAILED" },
    });
    expect((await lstat(`${path}${suffix}`)).isDirectory()).toBe(true);
  });

  it.each([
    "observer.claim.sqlite",
    "observer.claim.sqlite-journal",
    "observer.claim.sqlite-wal",
    "observer.claim.sqlite-shm",
    "OBSERVER.CLAIM.SQLITE",
  ])("rejects the reserved claim socket basename %s before mutation", async (socketName) => {
    const root = await tempRoot();
    const socketPath = join(root, "run", socketName);
    const path = observerBootClaimPath(socketPath);

    const claim = await acquireObserverBootClaim({ socketPath, timeoutMs: 50 });

    expect(claim).toMatchObject({
      status: "failed",
      error: { code: "OBSERVER_BOOT_CLAIM_FAILED" },
    });
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails on a corrupt database without replacing its inode or contents", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const path = observerBootClaimPath(socketPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not a sqlite database", { mode: 0o600 });
    const inode = (await stat(path)).ino;

    const claim = await acquireObserverBootClaim({ socketPath, timeoutMs: 50 });
    expect(claim).toMatchObject({
      status: "failed",
      error: { code: "OBSERVER_BOOT_CLAIM_FAILED" },
    });
    expect((await stat(path)).ino).toBe(inode);
    await expect(readFile(path, "utf8")).resolves.toBe("not a sqlite database");
  });

  it("maps permission and non-busy SQLite failures to claim failure", async () => {
    for (const error of [
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
      Object.assign(new Error("not busy"), { code: "ERR_SQLITE_ERROR", errcode: 11 }),
    ]) {
      const root = await tempRoot();
      const socketPath = join(root, "run", "observer.sock");
      const database = fakeDatabase({ beginError: error });
      const claim = await acquireObserverBootClaim(
        { socketPath, timeoutMs: 50 },
        { openDatabase: () => database },
      );
      expect(claim).toMatchObject({
        status: "failed",
        error: { code: "OBSERVER_BOOT_CLAIM_FAILED" },
      });
      if (claim.status === "failed") {
        expect(claim.error).toBeInstanceOf(Error);
      }
      expect(database.close).toHaveBeenCalledOnce();
    }
  });

  it("publishes an initialized database before entering the claim transaction", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const path = observerBootClaimPath(socketPath);
    const database = fakeDatabase();

    const claim = await acquireObserverBootClaim(
      { socketPath, timeoutMs: 100 },
      { openDatabase: () => database },
    );

    expect(claim.status).toBe("acquired");
    expect((await stat(path)).size).toBeGreaterThan(0);
    if (claim.status === "acquired") expect(claim.release()).toEqual({ status: "released" });
  });

  it("attempts both rollback and close, then caches a release failure", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const database = fakeDatabase({
      rollbackError: new Error("rollback failed"),
      closeError: new Error("close failed"),
    });
    const claim = await acquireObserverBootClaim(
      { socketPath, timeoutMs: 50 },
      { openDatabase: () => database },
    );
    expect(claim.status).toBe("acquired");
    if (claim.status !== "acquired") return;

    const released = claim.release();
    expect(released).toMatchObject({
      status: "failed",
      error: { code: "OBSERVER_BOOT_CLAIM_RELEASE_FAILED" },
    });
    if (released.status === "failed") {
      expect(released.error).toBeInstanceOf(Error);
    }
    expect(claim.release()).toBe(released);
    expect(database.exec).toHaveBeenCalledWith("ROLLBACK");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("keeps committed health available when rollback succeeds but close fails", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const database = fakeDatabase({ closeError: new Error("close failed") });
    const claim = await acquireObserverBootClaim(
      { socketPath, timeoutMs: 50 },
      { openDatabase: () => database },
    );
    expect(claim.status).toBe("acquired");
    if (claim.status !== "acquired") return;
    const gate = createObserverStartupGate();
    const health = vi.fn(async () => "healthy");
    const healthResult = gate.runHealth(health);

    const commit = gate.settleReady(() => claim.release());

    expect(commit).toMatchObject({
      status: "ready",
      claimRelease: {
        status: "failed",
        error: { code: "OBSERVER_BOOT_CLAIM_RELEASE_FAILED" },
      },
    });
    expect(database.exec).toHaveBeenCalledWith("ROLLBACK");
    await expect(healthResult).resolves.toBe("healthy");
    expect(health).toHaveBeenCalledOnce();
  });

  it("runs cleanup under a non-waiting claim and releases after callback success", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const exclusion = createObserverReapExclusion({ socketPath });
    const callback = vi.fn(async () => "done");

    await expect(exclusion.runExclusive(callback)).resolves.toEqual({
      status: "completed",
      value: "done",
      released: true,
    });
    expect(callback).toHaveBeenCalledOnce();
    const claim = await acquireObserverBootClaim({ socketPath, timeoutMs: 50 });
    expect(claim.status).toBe("acquired");
    if (claim.status === "acquired") claim.release();
  });

  it("refuses busy cleanup without invoking the callback", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const owner = await acquireObserverBootClaim({ socketPath, timeoutMs: 50 });
    expect(owner.status).toBe("acquired");
    if (owner.status !== "acquired") return;
    const callback = vi.fn(async () => "must not run");
    try {
      const exclusion = createObserverReapExclusion({ socketPath });
      await expect(exclusion.runExclusive(callback)).resolves.toEqual({ status: "busy" });
      expect(callback).not.toHaveBeenCalled();
    } finally {
      owner.release();
    }
  });

  it("releases cleanup exclusion after a callback failure", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "run", "observer.sock");
    const exclusion = createObserverReapExclusion({ socketPath });

    await expect(
      exclusion.runExclusive(async () => {
        throw new Error("callback failed");
      }),
    ).resolves.toMatchObject({ status: "failed" });
    const claim = await acquireObserverBootClaim({ socketPath, timeoutMs: 50 });
    expect(claim.status).toBe("acquired");
    if (claim.status === "acquired") claim.release();
  });

  it("does not construct providers or mutate runtime ownership after claim failure", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const socketPath = join(root, "run", "observer.sock");
    const path = observerBootClaimPath(socketPath);
    await mkdir(path, { recursive: true });
    const providerRegistryFactory = vi.fn(() => {
      throw new Error("providers must not be constructed");
    });

    await expect(
      runObserverMain(
        ["--state-dir", stateDir, "--socket", socketPath, "--startup-timeout-ms", "50"],
        { providerRegistryFactory },
      ),
    ).rejects.toMatchObject({ code: "OBSERVER_BOOT_CLAIM_FAILED" });
    expect(providerRegistryFactory).not.toHaveBeenCalled();
    await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${socketPath}.pid`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(stateDir, "observer.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(path)).isDirectory()).toBe(true);
  });

  it("preserves a non-exact owner when exact activation loses the post-stop race", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const socketPath = join(root, "run", "observer.sock");
    const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
    const providerRegistryFactory = vi.fn();
    const stop = vi.fn();
    const signal = vi.fn();

    try {
      await expect(
        runObserverMain(
          ["--state-dir", stateDir, "--socket", socketPath, "--startup-timeout-ms", "500"],
          {
            providerRegistryFactory,
            buildVersion: "1.0.0+station.candidate",
            startupPolicy: "preserve-incumbent",
            incumbentLifecycle: {
              health: vi.fn(async () => ({
                schemaVersion: "0.13.0",
                status: "healthy",
                pid: 4321,
                startedAt: "2026-08-19T12:00:00.000Z",
                version: "0.9.0+station.new-owner",
                socketPath,
              })),
              stop,
            },
            processEvidence: { socketHolders: vi.fn(), signal } as never,
          },
        ),
      ).rejects.toMatchObject({ code: "OBSERVER_EXACT_BUILD_ACTIVATION_FAILED" });
      expect(stop).not.toHaveBeenCalled();
      expect(signal).not.toHaveBeenCalled();
      expect(providerRegistryFactory).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("accepts an exact successor without constructing a competing runtime", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const socketPath = join(root, "run", "observer.sock");
    const buildVersion = "1.0.0+station.exact-owner";
    const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
    const providerRegistryFactory = vi.fn();

    try {
      await expect(
        runObserverMain(
          ["--state-dir", stateDir, "--socket", socketPath, "--startup-timeout-ms", "500"],
          {
            providerRegistryFactory,
            buildVersion,
            startupPolicy: "preserve-incumbent",
            incumbentLifecycle: {
              health: vi.fn(async () => ({
                schemaVersion: "0.13.0",
                status: "healthy",
                pid: 4321,
                startedAt: "2026-08-19T12:00:00.000Z",
                version: buildVersion,
                socketPath,
              })),
              stop: vi.fn(),
            },
            processEvidence: { socketHolders: vi.fn() } as never,
          },
        ),
      ).resolves.toBe(0);
      expect(providerRegistryFactory).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("does not report preserve-incumbent attach ready when startup cancellation wins", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const socketPath = join(root, "run", "observer.sock");
    const buildVersion = "1.0.0+station.exact-owner";
    const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
    const originalSigtermListeners = new Set(process.listeners("SIGTERM"));
    const startupReadinessSink = { ready: vi.fn() };
    const providerRegistryFactory = vi.fn();

    try {
      await expect(
        runObserverMain(
          ["--state-dir", stateDir, "--socket", socketPath, "--startup-timeout-ms", "500"],
          {
            providerRegistryFactory,
            buildVersion,
            startupPolicy: "preserve-incumbent",
            startupReadinessSink,
            incumbentLifecycle: {
              health: vi.fn(async () => {
                const startupListener = process
                  .listeners("SIGTERM")
                  .find((listener) => !originalSigtermListeners.has(listener));
                expect(startupListener).toBeDefined();
                startupListener?.();
                return {
                  schemaVersion: "0.13.0",
                  status: "healthy",
                  pid: 4321,
                  startedAt: "2026-08-19T12:00:00.000Z",
                  version: buildVersion,
                  socketPath,
                };
              }),
              stop: vi.fn(),
            },
            processEvidence: { socketHolders: vi.fn() } as never,
          },
        ),
      ).rejects.toMatchObject({ code: "OBSERVER_STARTUP_CANCELLED" });
      expect(startupReadinessSink.ready).not.toHaveBeenCalled();
      expect(providerRegistryFactory).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

async function tempRoot(prefix = "station-observer-claim-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function initializeClaimDatabase(socketPath: string): Promise<void> {
  const claim = await acquireObserverBootClaim({ socketPath, timeoutMs: 50 });
  expect(claim.status).toBe("acquired");
  if (claim.status === "acquired") expect(claim.release()).toEqual({ status: "released" });
}

function fakeDatabase(
  options: { beginError?: unknown; rollbackError?: unknown; closeError?: unknown } = {},
): SqlDatabase & { exec: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const exec = vi.fn((sql: string) => {
    if (sql === "BEGIN IMMEDIATE" && options.beginError !== undefined) {
      throw options.beginError;
    }
    if (sql === "ROLLBACK" && options.rollbackError !== undefined) {
      throw options.rollbackError;
    }
  });
  const close = vi.fn(() => {
    if (options.closeError !== undefined) {
      throw options.closeError;
    }
  });
  return {
    exec,
    prepare: vi.fn(() => {
      throw new Error("prepare is not used by the boot claim");
    }),
    close,
  };
}
