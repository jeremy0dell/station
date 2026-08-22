import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  OBSERVER_STARTUP_BOOT_LOG_TAIL_MAX_BYTES,
  OBSERVER_STARTUP_BOOT_LOG_TAIL_MAX_LINES,
  textLineTerminatorPattern,
} from "@station/contracts";
import { environmentWithoutGitLocals, stationObserverBuildVersion } from "@station/runtime";
import { selfExecArgv } from "../selfExec.js";
import {
  OBSERVER_STARTUP_FAILURE_FD,
  type ObserverStartupFailureReportReader,
  readObserverStartupFailureReport,
  STATION_OBSERVER_STARTUP_FAILURE_FD,
} from "./failureReport.js";
import type { ChildExitResult, ChildProcessLike, SpawnObserverInput } from "./types.js";

type DefaultSpawnObserverInput = SpawnObserverInput & {
  startupTimeoutMs: number;
  buildVersion?: string;
  processToken?: string;
};

/**
 * ADAPTER
 *
 * Spawns one detached Observer with a private failure-report descriptor and
 * child-owned boot log, then exposes bounded exit and diagnostic cleanup.
 */
export async function defaultSpawnObserver(
  input: DefaultSpawnObserverInput,
): Promise<ChildProcessLike> {
  const argv = observerSpawnArgv(input);
  const bootLogPath = observerBootLogPath(input.paths);
  const pendingBootLogPath = observerPendingBootLogPath(input.paths);
  await mkdir(dirname(bootLogPath), { recursive: true, mode: 0o700 });
  const bootLog = await open(pendingBootLogPath, "wx", 0o600);
  let child: ChildProcess | undefined;
  let bootLogReader: FileHandle | undefined;
  let failureReportReader: ObserverStartupFailureReportReader | undefined;
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
      detached: process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1",
      env: observerSpawnEnvironment(input),
      stdio: ["ignore", bootLog.fd, bootLog.fd, "pipe"],
    });
    const failureReportStream = child.stdio[OBSERVER_STARTUP_FAILURE_FD];
    if (!(failureReportStream instanceof Readable)) {
      throw new Error("Observer startup failure report pipe was unavailable.");
    }
    failureReportReader = readObserverStartupFailureReport(failureReportStream);
    const startedChild = Object.assign(
      childWithExit(child, failureReportReader),
      observerBootLogDiagnostics(bootLogReader),
    );
    await bootLog.close();
    return startedChild;
  } catch (error) {
    child?.kill();
    await bootLog.close().catch(() => undefined);
    await bootLogReader?.close().catch(() => undefined);
    failureReportReader?.dispose();
    if (!published) {
      await unlink(pendingBootLogPath).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Builds a child environment that defaults to generic singleton ordering and only
 * opts into preserve-incumbent admission for an explicit exact-build activation.
 */
export function observerSpawnEnvironment(
  input: Pick<DefaultSpawnObserverInput, "incumbentPolicy">,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = environmentWithoutGitLocals(inheritedEnvironment);
  // Caller tmux variables are evidence captured by the CLI, never Observer's
  // command endpoint or child-process context.
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.STATION_OBSERVER_STARTUP_POLICY;
  delete env[STATION_OBSERVER_STARTUP_FAILURE_FD];
  env[STATION_OBSERVER_STARTUP_FAILURE_FD] = String(OBSERVER_STARTUP_FAILURE_FD);
  if (input.incumbentPolicy === "preserve") {
    env.STATION_OBSERVER_STARTUP_POLICY = "preserve-incumbent";
  }
  return env;
}

export function observerSpawnArgv(input: DefaultSpawnObserverInput): [string, ...string[]] {
  // Compiled dist/observerProcess/spawn.js must resolve ../observerMain.js; source-alias tests launch the built entry instead.
  const observerEntry = import.meta.url.endsWith(".ts")
    ? new URL("../../dist/observerMain.js", import.meta.url)
    : new URL("../observerMain.js", import.meta.url);
  const observerCommand =
    input.observerCommand ?? selfExecArgv("observer", [process.execPath, observerEntry.pathname]);
  return [
    ...observerCommand,
    "--socket",
    input.paths.socketPath,
    "--state-dir",
    input.paths.stateDir,
    ...(input.configPath === undefined ? [] : ["--config", input.configPath]),
    "--startup-timeout-ms",
    String(input.startupTimeoutMs),
    "--build-version",
    input.buildVersion ?? stationObserverBuildVersion(),
    "--process-token",
    input.processToken ?? randomUUID(),
  ];
}

function childWithExit(
  child: ChildProcess,
  failureReportReader: ObserverStartupFailureReportReader,
): ChildProcessLike {
  let disposeExitWait!: () => void;
  // Report parsing can finish before the child exits, so rejection handling must exist immediately.
  const handledReport = failureReportReader.report.catch(() => undefined);
  const exited = new Promise<ChildExitResult>((resolve) => {
    let settled = false;
    const finish = async (result: ChildExitResult) => {
      if (settled) return;
      settled = true;
      disposeExitWait();
      const report = await handledReport;
      resolve(report === undefined ? result : { ...result, report });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      void finish({ type: "exit", code, signal });
    };
    const onError = (error: Error) => {
      void finish({ type: "spawn_error", error });
    };
    disposeExitWait = () => {
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return Object.assign(child, {
    exited,
    disposeExitWait,
    disposeFailureReport: failureReportReader.dispose,
  });
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
  const { size } = await bootLog.stat();
  if (size === 0) return undefined;
  const length = Math.min(size, OBSERVER_STARTUP_BOOT_LOG_TAIL_MAX_BYTES);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await bootLog.read(buffer, 0, length, size - length);
  let content = buffer.subarray(0, bytesRead).toString("utf8");
  if (size > length) {
    const firstTerminator = textLineTerminatorPattern.exec(content);
    if (firstTerminator !== null) {
      content = content.slice(firstTerminator.index + firstTerminator[0].length);
    }
  }
  content = content.trimEnd();
  if (content.trim().length === 0) return undefined;
  return content
    .split(textLineTerminatorPattern)
    .slice(-OBSERVER_STARTUP_BOOT_LOG_TAIL_MAX_LINES)
    .join("\n");
}
