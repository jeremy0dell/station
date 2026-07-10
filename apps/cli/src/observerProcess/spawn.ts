import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChildExitResult, ChildProcessLike, SpawnObserverInput } from "./types.js";

export async function defaultSpawnObserver(input: SpawnObserverInput): Promise<ChildProcessLike> {
  const argv = observerSpawnArgv(input);
  const bootLogPath = observerBootLogPath(input.paths);
  const pendingBootLogPath = observerPendingBootLogPath(input.paths);
  await mkdir(dirname(bootLogPath), { recursive: true, mode: 0o700 });
  const bootLog = await open(pendingBootLogPath, "wx", 0o600);
  let child: ChildProcess | undefined;
  let bootLogReader: FileHandle | undefined;
  let published = false;
  try {
    await bootLog.chmod(0o600);
    await bootLog.writeFile(`${JSON.stringify({ command: argv })}\n`, "utf8");
    bootLogReader = await open(pendingBootLogPath, "r");
    // Atomic replacement keeps the latest path coherent while each child writes to its own inherited inode.
    await rename(pendingBootLogPath, bootLogPath);
    published = true;
    const [command, ...args] = argv;
    child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", bootLog.fd, bootLog.fd],
    });
    const startedChild = Object.assign(
      childWithExit(child),
      observerBootLogDiagnostics(bootLogReader),
    );
    await bootLog.close();
    return startedChild;
  } catch (error) {
    child?.kill();
    await bootLog.close().catch(() => undefined);
    await bootLogReader?.close().catch(() => undefined);
    if (!published) {
      await unlink(pendingBootLogPath).catch(() => undefined);
    }
    throw error;
  }
}

function observerSpawnArgv(input: SpawnObserverInput): [string, ...string[]] {
  // Compiled dist/observerProcess/spawn.js must resolve ../observerMain.js; source-alias tests launch the built entry instead.
  const observerEntry = import.meta.url.endsWith(".ts")
    ? new URL("../../dist/observerMain.js", import.meta.url)
    : new URL("../observerMain.js", import.meta.url);
  return [
    process.execPath,
    observerEntry.pathname,
    "--socket",
    input.paths.socketPath,
    "--state-dir",
    input.paths.stateDir,
    ...(input.configPath === undefined ? [] : ["--config", input.configPath]),
  ];
}

function childWithExit(child: ChildProcess): ChildProcessLike {
  let disposeExitWait!: () => void;
  const exited = new Promise<ChildExitResult>((resolve) => {
    let settled = false;
    const finish = (result: ChildExitResult) => {
      if (settled) return;
      settled = true;
      disposeExitWait();
      resolve(result);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ type: "exit", code, signal });
    };
    const onError = (error: Error) => {
      finish({ type: "spawn_error", error });
    };
    disposeExitWait = () => {
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return Object.assign(child, { exited, disposeExitWait });
}

export async function readObserverBootLogTail(path: string): Promise<string | undefined> {
  const bootLog = await open(path, "r");
  try {
    return await readObserverBootLogTailFromHandle(bootLog);
  } finally {
    await bootLog.close();
  }
}

export function observerBootLogPath(paths: SpawnObserverInput["paths"]): string {
  return join(paths.stateDir, "logs", "observer-boot.log");
}

function observerPendingBootLogPath(paths: SpawnObserverInput["paths"]): string {
  return join(
    dirname(observerBootLogPath(paths)),
    `.observer-boot.${process.pid}.${randomUUID()}.tmp`,
  );
}

function observerBootLogDiagnostics(bootLog: FileHandle): {
  readBootLogTail: () => Promise<string | undefined>;
  disposeBootLog: () => Promise<void>;
} {
  let disposed = false;
  return {
    readBootLogTail: () => readObserverBootLogTailFromHandle(bootLog),
    disposeBootLog: async () => {
      if (disposed) return;
      disposed = true;
      await bootLog.close();
    },
  };
}

async function readObserverBootLogTailFromHandle(bootLog: FileHandle): Promise<string | undefined> {
  const maxBytes = 64 * 1024;
  const { size } = await bootLog.stat();
  if (size === 0) return undefined;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await bootLog.read(buffer, 0, length, size - length);
  let content = buffer.subarray(0, bytesRead).toString("utf8");
  if (size > length) {
    const firstNewline = content.indexOf("\n");
    if (firstNewline !== -1) content = content.slice(firstNewline + 1);
  }
  content = content.trimEnd();
  if (content.trim().length === 0) return undefined;
  return content.split(/\r?\n/).slice(-15).join("\n");
}
