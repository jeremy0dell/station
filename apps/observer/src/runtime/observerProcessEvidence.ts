import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveObserverSocketForProcessArgs } from "@station/config";
import { z } from "zod";
import type { ObserverDuplicateProcessEvidenceSource } from "./observerDuplicateCleanup.js";
import type { ObserverProcessEntry, ObserverProcessSignalResult } from "./observerHandoff.js";
import { readObserverProcessIdentity } from "./observerPidfile.js";
import { readObserverSocketHolderPids } from "./server.js";
import { readSocketIdentity } from "./socketOwnership.js";

const processListLinePattern =
  /^\s*(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.+)$/u;
const ProcessListLineSchema = z.string().regex(processListLinePattern);
const PositivePidSchema = z.coerce.number().int().positive();
const ErrorCodeSchema = z.object({ code: z.string() });
const processListingMaxBufferBytes = 8 * 1024 * 1024;
const observerArgFlags = ["config", "socket", "state-dir", "startup-timeout-ms"] as const;
const psPath = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
const lsofPath = process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
const LsofProcessHeaderSchema = z.string().regex(/^p[1-9]\d*$/u);
const LsofFileDescriptorSchema = z
  .string()
  .regex(/^f(?:[0-9]+[A-Za-z-]*|cwd|err|jld|ltx|m[0-9]*|mem|NOFD|pd|rtd|txt)$/u);
const LsofNameSchema = z.string().regex(/^n.*$/u);

type ExecFileStatus = { status: number | null; stdout: string; stderr: string };

type LocalObserverProcessEvidenceDeps = {
  execFile?: (file: string, args: readonly string[]) => string;
  execFileStatus?: (file: string, args: readonly string[]) => ExecFileStatus;
  socketHolders?: (socketPath: string) => number[];
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
};

/**
 * ADAPTER
 *
 * Translates ps, strict socket-holder and per-process Unix-socket-FD evidence,
 * pidfiles, socket identities, and process signals into conservative ownership
 * evidence; unavailable evidence throws instead of meaning zero.
 */
export function createLocalObserverProcessEvidence(
  deps: LocalObserverProcessEvidenceDeps = {},
): ObserverDuplicateProcessEvidenceSource {
  const execFile = deps.execFile ?? defaultExecFile;
  const execFileStatus = deps.execFileStatus ?? defaultExecFileStatus;
  const signal = deps.signal ?? process.kill;
  return {
    listObserverProcesses: () => parseObserverProcessList(execFile(psPath, processListArgs())),
    socketHolders: deps.socketHolders ?? readObserverSocketHolderPids,
    processStartToken: (pid) => readProcessStartToken(pid, execFile),
    readProcessIdentity: readObserverProcessIdentity,
    socketIdentity: readSocketIdentity,
    unixSocketFdCount: (pid) => readUnixSocketFdCount(pid, execFileStatus),
    signal: (pid, requestedSignal) => signalProcess(pid, requestedSignal, signal),
  };
}

export function parseObserverProcessList(output: string): ObserverProcessEntry[] {
  const entries: ObserverProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const parsedLine = ProcessListLineSchema.safeParse(line);
    if (!parsedLine.success) continue;
    const match = processListLinePattern.exec(parsedLine.data);
    if (match === null) continue;
    const pid = PositivePidSchema.safeParse(match[1]);
    const startToken = match[2]?.trim();
    const command = match[3];
    if (!pid.success || startToken === undefined || command === undefined) continue;
    const argv = command.split(/\s+/u).filter((token) => token.length > 0);
    if (!isObserverArgv(argv) && !isSpacedCompiledObserverCommand(command)) continue;
    // ps flattens argv boundaries, so recover an explicit socket from the raw
    // command before whitespace splitting can corrupt paths containing spaces.
    const explicitSocketPath = rawObserverFlagValue(command, "socket");
    const socketPath =
      explicitSocketPath === undefined
        ? resolveObserverSocketForProcessArgs(argv)
        : resolveObserverSocketForProcessArgs([argv[0] ?? "", "--socket", explicitSocketPath]);
    const entry: ObserverProcessEntry = { pid: pid.data, argv, startToken };
    if (socketPath !== undefined) entry.socketPath = socketPath;
    const advertisedStartupTimeout = PositivePidSchema.safeParse(
      rawObserverFlagValue(command, "startup-timeout-ms"),
    );
    if (advertisedStartupTimeout.success) {
      entry.startupTimeoutMs = advertisedStartupTimeout.data;
    }
    entries.push(entry);
  }
  return entries;
}

function isSpacedCompiledObserverCommand(command: string): boolean {
  // The exact executable path check preserves shell-wrapper exclusion after ps flattens argv boundaries.
  const marker = " __observer";
  let markerIndex = command.indexOf(marker);
  while (markerIndex !== -1) {
    const tokenEnd = markerIndex + marker.length;
    const executable = command.slice(0, markerIndex).trim();
    if (
      /\s/u.test(executable) &&
      executable.endsWith("/stn") &&
      (command[tokenEnd] === undefined || /\s/u.test(command[tokenEnd])) &&
      existsSync(executable)
    ) {
      return true;
    }
    markerIndex = command.indexOf(marker, markerIndex + marker.length);
  }
  return false;
}

function processListArgs(): string[] {
  return ["-axww", "-o", "pid=,lstart=,command="];
}

function isObserverArgv(argv: readonly string[]): boolean {
  const executable = argv[0] ?? "";
  const isNode = executable === "node" || executable.endsWith("/node");
  const isSourceObserver = isNode && argv[1]?.endsWith("observerMain.js") === true;
  const isStationBinary = executable === "stn" || executable.endsWith("/stn");
  return isSourceObserver || (isStationBinary && argv[1] === "__observer");
}

function readProcessStartToken(
  pid: number,
  execFile: (file: string, args: readonly string[]) => string,
): string | undefined {
  try {
    const token = execFile(psPath, ["-ww", "-p", String(pid), "-o", "lstart="]).trim();
    return token.length === 0 ? undefined : token;
  } catch {
    return undefined;
  }
}

function rawObserverFlagValue(
  command: string,
  flag: (typeof observerArgFlags)[number],
): string | undefined {
  const marker = ` --${flag} `;
  const start = command.indexOf(marker);
  if (start === -1) return undefined;
  const valueStart = start + marker.length;
  const boundaries = observerArgFlags
    .map((candidate) => command.indexOf(` --${candidate} `, valueStart))
    .filter((index) => index !== -1);
  const end = boundaries.length === 0 ? command.length : Math.min(...boundaries);
  const value = command.slice(valueStart, end).trim();
  return value.length === 0 ? undefined : value;
}

export function parseUnixSocketFdCount(output: string, expectedPid: number): number {
  const lines = output.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return 0;
  const expectedHeader = `p${expectedPid}`;
  if (!LsofProcessHeaderSchema.safeParse(lines[0]).success || lines[0] !== expectedHeader) {
    throw new Error("Unix-socket descriptor evidence named an unexpected process.");
  }

  let descriptors = 0;
  let sawDescriptor = false;
  for (const line of lines.slice(1)) {
    if (LsofFileDescriptorSchema.safeParse(line).success) {
      descriptors += 1;
      sawDescriptor = true;
      continue;
    }
    if (!sawDescriptor || !LsofNameSchema.safeParse(line).success) {
      throw new Error("Unix-socket descriptor evidence was malformed.");
    }
  }
  return descriptors;
}

function readUnixSocketFdCount(
  pid: number,
  execFileStatus: (file: string, args: readonly string[]) => ExecFileStatus,
): number {
  const result = execFileStatus(lsofPath, ["-nP", "-a", "-U", "-p", String(pid), "-F", "pfn"]);
  if (result.status === 0) return parseUnixSocketFdCount(result.stdout, pid);
  if (
    result.status === 1 &&
    result.stdout.trim().length === 0 &&
    result.stderr.trim().length === 0
  ) {
    return 0;
  }
  throw new Error(`Unix-socket descriptor evidence failed for PID ${pid}.`);
}

function signalProcess(
  pid: number,
  signal: NodeJS.Signals | 0,
  send: (pid: number, signal: NodeJS.Signals | 0) => void,
): ObserverProcessSignalResult {
  try {
    send(pid, signal);
    return "sent";
  } catch (error) {
    const parsed = ErrorCodeSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ESRCH") return "absent";
    return "refused";
  }
}

function defaultExecFile(file: string, args: readonly string[]): string {
  return execFileSync(file, [...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: processListingMaxBufferBytes,
  });
}

function defaultExecFileStatus(file: string, args: readonly string[]): ExecFileStatus {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: processListingMaxBufferBytes,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
