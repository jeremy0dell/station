import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  withCodexHookMutationLock,
  withCodexHookMutationLockForTest,
} from "../../src/hooks/hookMutationLock";
import type { CodexHookLockDatabase } from "../../src/hooks/hookMutationLockSqlite";

describe("Codex hook mutation lock", () => {
  it("serializes reversed multi-artifact acquisitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const firstArtifact = join(root, "a", "config.toml");
    const secondArtifact = join(root, "b", "hook.sh");
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];

    const first = withCodexHookMutationLock([secondArtifact, firstArtifact], async () => {
      order.push("first-entered");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first-released");
    });
    await firstEntered.promise;

    let secondEntered = false;
    const second = withCodexHookMutationLock([firstArtifact, secondArtifact], async () => {
      secondEntered = true;
      order.push("second-entered");
    });
    await sleep(75);
    expect(secondEntered).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-entered", "first-released", "second-entered"]);
  });

  it("uses the absolute deadline and returns a typed timeout without entering the effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const artifact = join(root, "config.toml");
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const first = withCodexHookMutationLock([artifact], async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    let waiterEntered = false;
    await expect(
      withCodexHookMutationLock(
        [artifact],
        async () => {
          waiterEntered = true;
        },
        { deadlineMs: performance.now() + 40, timeoutMs: 1_000 },
      ),
    ).rejects.toMatchObject({
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_RECONCILIATION_TIMEOUT",
    });
    expect(waiterEntered).toBe(false);

    releaseFirst.resolve();
    await first;
  });

  it("aborts a waiter without entering its effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const artifact = join(root, "config.toml");
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const first = withCodexHookMutationLock([artifact], async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    const controller = new AbortController();
    const abortReason = new Error("test cancellation");
    let waiterEntered = false;
    const waiter = withCodexHookMutationLock(
      [artifact],
      async () => {
        waiterEntered = true;
      },
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    await sleep(40);
    controller.abort(abortReason);

    await expect(waiter).rejects.toBe(abortReason);
    expect(waiterEntered).toBe(false);

    releaseFirst.resolve();
    await first;
  });

  it("returns a typed cancellation when an aborted signal exposes no reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const artifact = join(root, "config.toml");
    const signal = { aborted: true, reason: undefined } as AbortSignal;

    await expect(
      withCodexHookMutationLock([artifact], async () => undefined, { signal }),
    ).rejects.toMatchObject({
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_RECONCILIATION_CANCELLED",
    });
  });

  it("acquires after a process holding the SQLite transaction crashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const artifact = join(root, "config.toml");
    const lockDatabasePath = `${artifact}.station-hook.lock.sqlite`;
    await mkdir(root, { recursive: true });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import { DatabaseSync } from "node:sqlite";',
          "const database = new DatabaseSync(process.argv[1]);",
          'database.exec("BEGIN IMMEDIATE");',
          'process.stdout.write("locked\\n");',
          "setInterval(() => undefined, 1_000);",
        ].join("\n"),
        lockDatabasePath,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    try {
      await waitForOutput(child, "locked\n");
      let entered = false;
      const waiter = withCodexHookMutationLock(
        [artifact],
        async () => {
          entered = true;
        },
        { timeoutMs: 2_000 },
      );
      await sleep(75);
      expect(entered).toBe(false);

      child.kill("SIGKILL");
      await waiter;
      expect(entered).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("restricts a pre-existing regular lock database to mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const artifact = join(root, "config.toml");
    const lockDatabasePath = `${artifact}.station-hook.lock.sqlite`;
    await writeFile(lockDatabasePath, "", { mode: 0o666 });

    await withCodexHookMutationLock([artifact], async () => undefined);

    expect((await stat(lockDatabasePath)).mode & 0o7777).toBe(0o600);
  });

  it("refuses a pre-existing symlink lock database without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const artifact = join(root, "config.toml");
    const lockDatabasePath = `${artifact}.station-hook.lock.sqlite`;
    const target = join(root, "target.txt");
    await writeFile(target, "sentinel", { mode: 0o644 });
    await symlink(target, lockDatabasePath);

    await expect(
      withCodexHookMutationLock([artifact], async () => undefined),
    ).rejects.toMatchObject({
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_RECONCILIATION_LOCK_FAILED",
    });
    await expect(readFile(target, "utf8")).resolves.toBe("sentinel");
    expect((await stat(target)).mode & 0o7777).toBe(0o644);
  });

  it("refuses a pre-existing non-regular lock database", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const artifact = join(root, "config.toml");
    const lockDatabasePath = `${artifact}.station-hook.lock.sqlite`;
    await mkdir(lockDatabasePath);

    await expect(
      withCodexHookMutationLock([artifact], async () => undefined),
    ).rejects.toMatchObject({
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_RECONCILIATION_LOCK_FAILED",
    });
  });

  it.each([
    "rollback",
    "close",
  ] as const)("returns a typed release failure when SQLite %s fails after a successful effect", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const artifact = join(root, "config.toml");
    const events: string[] = [];

    await expect(
      withCodexHookMutationLockForTest(
        [artifact],
        async () => {
          events.push("effect");
        },
        () => releaseFailureDatabase(failure, events),
      ),
    ).rejects.toMatchObject({
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_RECONCILIATION_LOCK_RELEASE_FAILED",
    });
    expect(events).toEqual(["BEGIN IMMEDIATE", "effect", "ROLLBACK", "close"]);
  });

  it("preserves the effect failure when rollback and close also fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const artifact = join(root, "config.toml");
    const effectFailure = new Error("writer failed");

    await expect(
      withCodexHookMutationLockForTest(
        [artifact],
        async () => {
          throw effectFailure;
        },
        () => releaseFailureDatabase("both", []),
      ),
    ).rejects.toBe(effectFailure);
  });

  it("rolls back and closes multiple artifact locks in reverse acquisition order", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hook-lock-"));
    const firstArtifact = join(root, "a.toml");
    const secondArtifact = join(root, "b.toml");
    const events: string[] = [];

    await withCodexHookMutationLockForTest(
      [secondArtifact, firstArtifact],
      async () => undefined,
      (path) => recordingDatabase(path, events),
    );

    expect(events.slice(-4)).toEqual([
      `${secondArtifact}.station-hook.lock.sqlite:ROLLBACK`,
      `${secondArtifact}.station-hook.lock.sqlite:close`,
      `${firstArtifact}.station-hook.lock.sqlite:ROLLBACK`,
      `${firstArtifact}.station-hook.lock.sqlite:close`,
    ]);
  });
});

function releaseFailureDatabase(
  failure: "rollback" | "close" | "both",
  events: string[],
): CodexHookLockDatabase {
  return {
    exec: (sql) => {
      events.push(sql);
      if (sql === "ROLLBACK" && (failure === "rollback" || failure === "both")) {
        throw new Error("rollback failed");
      }
    },
    close: () => {
      events.push("close");
      if (failure === "close" || failure === "both") {
        throw new Error("close failed");
      }
    },
  };
}

function recordingDatabase(path: string, events: string[]): CodexHookLockDatabase {
  return {
    exec: (sql) => events.push(`${path}:${sql}`),
    close: () => events.push(`${path}:close`),
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForOutput(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Lock holder exited before readiness: code=${code}, signal=${signal}`));
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}
