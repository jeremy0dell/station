import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SetupStateDirFact } from "../model.js";

type SetupStateDirFileHandle = {
  close(): Promise<void>;
  writeFile(data: string): Promise<void>;
};

export type SetupStateDirFileSystem = {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(path: string, flags: "wx", mode: number): Promise<SetupStateDirFileHandle>;
  unlink(path: string): Promise<void>;
};

export type CheckSetupStateDirOptions = {
  path: string;
  executable?: boolean;
  execute?: (path: string) => Promise<void>;
  fs?: SetupStateDirFileSystem;
  probeName?: string;
};

/** Proves the writable state-directory prerequisite shared by source and compiled launch. */
export async function checkSetupStateDir(
  options: CheckSetupStateDirOptions,
): Promise<SetupStateDirFact> {
  const fs = options.fs ?? nodeStateDirFileSystem;
  const probePath = join(
    options.path,
    options.probeName ?? `.station-write-probe-${process.pid}-${randomUUID()}`,
  );
  let handle: SetupStateDirFileHandle | undefined;
  let executionFailed = false;
  try {
    await fs.mkdir(options.path, { recursive: true, mode: 0o700 });
    handle = await fs.open(probePath, "wx", options.executable === true ? 0o700 : 0o600);
    if (options.executable === true) {
      await handle.writeFile("#!/bin/sh\nexit 0\n");
    }
    await handle.close();
    handle = undefined;
    if (options.executable === true) {
      try {
        await (options.execute ?? executeProbe)(probePath);
      } catch (error) {
        executionFailed = true;
        throw error;
      }
    }
    await fs.unlink(probePath);
    return { status: "ok", path: options.path };
  } catch {
    await handle?.close().catch(() => undefined);
    await fs.unlink(probePath).catch(() => undefined);
    return {
      status: "missing",
      path: options.path,
      message: executionFailed
        ? `STATION state directory does not permit executable assets at ${options.path}.`
        : `STATION state directory is not writable at ${options.path}.`,
    };
  }
}

function executeProbe(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`Executable state-directory probe exited ${code ?? signal ?? "unknown"}.`),
        );
      }
    });
  });
}

const nodeStateDirFileSystem: SetupStateDirFileSystem = {
  mkdir,
  open,
  unlink,
};
