import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { resolveObserverSocketForProcessArgs } from "@station/config";
import { ObserverProcessTokenSchema, type SafeError } from "@station/contracts";
import { z } from "zod";
import {
  type ObserverProcessEntry,
  type ObserverProcessSignalResult,
  observerBuildSelectorIsValid,
  observerProcessEntriesMatch,
} from "./observerHandoff.js";
import { readObserverProcessIdentity } from "./observerPidfile.js";
import type { ObserverDuplicateProcessEvidenceSource } from "./observerReap.js";
import { readObserverSocketHolderPids } from "./server.js";
import { readSocketIdentity } from "./socketOwnership.js";

const processListLinePattern =
  /^\s*(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.+)$/u;
const ProcessListLineSchema = z.string().regex(processListLinePattern);
const PositivePidSchema = z.coerce.number().int().positive();
const ErrorCodeSchema = z.object({ code: z.string() });
const processListingMaxBufferBytes = 8 * 1024 * 1024;
const psPath = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
const lsofPath = process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
const sourceObserverSuffix = "/apps/cli/dist/observerMain.js";
const requiredObserverFlags = [
  "socket",
  "state-dir",
  "startup-timeout-ms",
  "build-version",
  "process-token",
] as const;

type ExecFileStatus = { status: number | null; stdout: string; stderr: string };

type LocalObserverProcessEvidenceDeps = {
  execFile?: (file: string, args: readonly string[]) => string;
  execFileStatus?: (file: string, args: readonly string[]) => ExecFileStatus;
  readProcessArgv?: (pid: number) => string[] | undefined;
  processExecutableMatches?: (pid: number, expectedPath: string) => boolean;
  socketHolders?: (socketPath: string) => number[];
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
};

/**
 * ADAPTER
 *
 * Translates targeted and global exact argv, executable provenance, launch nonce,
 * OS start time, strict socket-holder and complete file-descriptor evidence,
 * pidfiles, socket identities, and signals into conservative ownership evidence.
 * Exact executable/argv mismatch throws a stable typed refusal without weakening
 * the fail-closed ownership decision.
 */
export function createLocalObserverProcessEvidence(
  deps: LocalObserverProcessEvidenceDeps = {},
): ObserverDuplicateProcessEvidenceSource {
  const execFile = deps.execFile ?? defaultExecFile;
  const execFileStatus = deps.execFileStatus ?? defaultExecFileStatus;
  const readProcessArgv = deps.readProcessArgv ?? defaultReadProcessArgv;
  const processExecutableMatches =
    deps.processExecutableMatches ??
    ((pid, expectedPath) => defaultProcessExecutableMatches(pid, expectedPath, execFileStatus));
  const signal = deps.signal ?? process.kill;
  const readEntries = (args: readonly string[]): ObserverProcessEntry[] => {
    const parsed = parseObserverProcessList(execFile(psPath, args));
    return parsed.map((entry) =>
      requireExactLocalObserverProcess(entry, readProcessArgv, processExecutableMatches),
    );
  };
  const readObserverProcess = (pid: number): ObserverProcessEntry | undefined =>
    readEntries(["-ww", "-p", String(pid), "-o", "pid=,lstart=,command="]).find(
      (entry) => entry.pid === pid,
    );
  const readExactProcess = (expected: ObserverProcessEntry): ObserverProcessEntry => {
    const current = readObserverProcess(expected.pid);
    if (current === undefined || !observerProcessEntriesMatch(current, expected)) {
      throw new Error(`Observer process ${expected.pid} changed while evidence was collected.`);
    }
    return current;
  };

  return {
    readObserverProcess,
    listObserverProcesses: () => readEntries(processListArgs()),
    socketHolders: deps.socketHolders ?? readObserverSocketHolderPids,
    processStartToken: (pid) => readProcessStartToken(pid, execFile),
    readProcessIdentity: readObserverProcessIdentity,
    socketIdentity: readSocketIdentity,
    unixSocketFdCount: (entry) => {
      readExactProcess(entry);
      const result = execFileStatus(lsofPath, ["-nP", "-a", "-p", String(entry.pid), "-F0pft"]);
      if (result.status !== 0 || result.stderr.trim().length !== 0) {
        throw new Error(`Unix-socket descriptor evidence failed for PID ${entry.pid}.`);
      }
      const count = parseUnixSocketFdCount(result.stdout, entry.pid);
      readExactProcess(entry);
      return count;
    },
    signal: (pid, requestedSignal) => signalProcess(pid, requestedSignal, signal),
  };
}

export function parseObserverProcessList(output: string): ObserverProcessEntry[] {
  const entries: ObserverProcessEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsedLine = ProcessListLineSchema.safeParse(line);
    if (!parsedLine.success) {
      if (looksLikeIdentifiedObserver(line)) {
        throw new Error("Observer process listing was malformed or truncated.");
      }
      continue;
    }
    const match = processListLinePattern.exec(parsedLine.data);
    const pid = PositivePidSchema.safeParse(match?.[1]);
    const startToken = match?.[2]?.trim();
    const command = match?.[3];
    if (!pid.success || startToken === undefined || command === undefined) continue;
    const parsedCommand = parseFlattenedObserverCommand(command);
    if (parsedCommand === undefined) {
      if (looksLikeIdentifiedObserver(command)) {
        throw new Error("Observer argv boundaries or provenance were ambiguous.");
      }
      continue;
    }
    entries.push({ pid: pid.data, startToken, ...parsedCommand });
  }
  return entries;
}

function parseFlattenedObserverCommand(
  command: string,
): Omit<ObserverProcessEntry, "pid" | "startToken"> | undefined {
  const indexes = observerFlagIndexes(command);
  if (indexes === undefined) return undefined;
  const configIndexes = markerIndexes(command, " --config ");
  if (configIndexes.length > 1) return undefined;
  const configIndex = configIndexes[0];
  if (
    configIndex !== undefined &&
    (configIndex <= indexes.stateDir || configIndex >= indexes.startupTimeout)
  ) {
    return undefined;
  }

  const prefix = strictSegment(command, 0, indexes.socket);
  const socketPath = strictSegment(command, indexes.socketEnd, indexes.stateDir);
  const stateEnd = configIndex ?? indexes.startupTimeout;
  const stateDir = strictSegment(command, indexes.stateDirEnd, stateEnd);
  const configPath =
    configIndex === undefined
      ? undefined
      : strictSegment(command, configIndex + " --config ".length, indexes.startupTimeout);
  const startupTimeoutValue = strictSegment(
    command,
    indexes.startupTimeoutEnd,
    indexes.buildVersion,
  );
  const buildVersion = strictSegment(command, indexes.buildVersionEnd, indexes.processToken);
  const processToken = strictSegment(command, indexes.processTokenEnd, command.length);
  if (
    prefix === undefined ||
    socketPath === undefined ||
    stateDir === undefined ||
    (configIndex !== undefined && configPath === undefined) ||
    startupTimeoutValue === undefined ||
    buildVersion === undefined ||
    processToken === undefined
  ) {
    return undefined;
  }
  const startupTimeoutMs = Number(startupTimeoutValue);
  if (
    !/^[1-9]\d*$/u.test(startupTimeoutValue) ||
    !Number.isSafeInteger(startupTimeoutMs) ||
    !observerBuildSelectorIsValid(buildVersion) ||
    !ObserverProcessTokenSchema.safeParse(processToken).success
  ) {
    return undefined;
  }
  const commandPrefix = parseObserverCommandPrefix(prefix);
  if (commandPrefix === undefined) return undefined;
  const argv = [
    ...commandPrefix,
    "--socket",
    socketPath,
    "--state-dir",
    stateDir,
    ...(configPath === undefined ? [] : ["--config", configPath]),
    "--startup-timeout-ms",
    startupTimeoutValue,
    "--build-version",
    buildVersion,
    "--process-token",
    processToken,
  ];
  const resolvedSocketPath = resolveObserverSocketForProcessArgs(argv);
  if (resolvedSocketPath === undefined) return undefined;
  return {
    argv,
    executablePath: commandPrefix[0] ?? "",
    processToken: processToken.toLowerCase(),
    buildVersion,
    socketPath: resolvedSocketPath,
    startupTimeoutMs,
  };
}

function observerFlagIndexes(command: string):
  | {
      socket: number;
      socketEnd: number;
      stateDir: number;
      stateDirEnd: number;
      startupTimeout: number;
      startupTimeoutEnd: number;
      buildVersion: number;
      buildVersionEnd: number;
      processToken: number;
      processTokenEnd: number;
    }
  | undefined {
  const positions = new Map<string, number>();
  for (const flag of requiredObserverFlags) {
    const marker = ` --${flag} `;
    const indexes = markerIndexes(command, marker);
    if (indexes.length !== 1) return undefined;
    positions.set(flag, indexes[0] as number);
  }
  const socket = positions.get("socket") as number;
  const stateDir = positions.get("state-dir") as number;
  const startupTimeout = positions.get("startup-timeout-ms") as number;
  const buildVersion = positions.get("build-version") as number;
  const processToken = positions.get("process-token") as number;
  if (
    !(
      socket < stateDir &&
      stateDir < startupTimeout &&
      startupTimeout < buildVersion &&
      buildVersion < processToken
    )
  ) {
    return undefined;
  }
  return {
    socket,
    socketEnd: socket + " --socket ".length,
    stateDir,
    stateDirEnd: stateDir + " --state-dir ".length,
    startupTimeout,
    startupTimeoutEnd: startupTimeout + " --startup-timeout-ms ".length,
    buildVersion,
    buildVersionEnd: buildVersion + " --build-version ".length,
    processToken,
    processTokenEnd: processToken + " --process-token ".length,
  };
}

function markerIndexes(value: string, marker: string): number[] {
  const indexes: number[] = [];
  let index = value.indexOf(marker);
  while (index !== -1) {
    indexes.push(index);
    index = value.indexOf(marker, index + marker.length);
  }
  return indexes;
}

function strictSegment(value: string, start: number, end: number): string | undefined {
  const segment = value.slice(start, end);
  return segment.length > 0 && segment === segment.trim() ? segment : undefined;
}

function parseObserverCommandPrefix(prefix: string): string[] | undefined {
  const compiledMarker = " __observer";
  if (prefix.endsWith(compiledMarker)) {
    const executable = prefix.slice(0, -compiledMarker.length);
    if (isAbsolute(executable) && basename(executable) === "stn") {
      return [executable, "__observer"];
    }
    return undefined;
  }

  const candidates: string[][] = [];
  for (let index = prefix.indexOf(" "); index !== -1; index = prefix.indexOf(" ", index + 1)) {
    const executable = prefix.slice(0, index);
    const script = prefix.slice(index + 1);
    if (
      isAbsolute(executable) &&
      basename(executable) === "node" &&
      isAbsolute(script) &&
      script.endsWith(sourceObserverSuffix)
    ) {
      candidates.push([executable, script]);
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function looksLikeIdentifiedObserver(command: string): boolean {
  return (
    command.includes(" --process-token ") &&
    (command.includes(" __observer") || command.includes("observerMain.js"))
  );
}

function requireExactLocalObserverProcess(
  entry: ObserverProcessEntry,
  readProcessArgv: (pid: number) => string[] | undefined,
  processExecutableMatches: (pid: number, expectedPath: string) => boolean,
): ObserverProcessEntry {
  const exactArgv = readProcessArgv(entry.pid);
  if (
    (exactArgv !== undefined &&
      (exactArgv.length !== entry.argv.length ||
        exactArgv.some((value, index) => value !== entry.argv[index]))) ||
    !processExecutableMatches(entry.pid, entry.executablePath)
  ) {
    throw observerProcessExecutableArgvMismatch();
  }
  const scriptPath = entry.argv[1];
  if (scriptPath !== "__observer") {
    if (scriptPath === undefined || !realpathSync(scriptPath).endsWith(sourceObserverSuffix)) {
      throw new Error(`Observer process ${entry.pid} did not have exact source provenance.`);
    }
  }
  return { ...entry, executablePath: realpathSync(entry.executablePath) };
}

function observerProcessExecutableArgvMismatch(): Error & SafeError {
  const safeError: SafeError = {
    tag: "ObserverProcessEvidenceError",
    code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
    message: "Observer process evidence did not match the exact executable and argv.",
  };
  return Object.assign(new Error(safeError.message), safeError);
}

function processListArgs(): string[] {
  return ["-axww", "-o", "pid=,lstart=,command="];
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

export function parseUnixSocketFdCount(output: string, expectedPid: number): number {
  const lines = strictLsofLines(output, expectedPid);
  if (lines.length < 2) throw new Error("Unix-socket descriptor evidence was empty.");
  let descriptors = 0;
  for (const line of lines.slice(1)) {
    const fields = strictNulFields(line);
    if (
      fields.length !== 2 ||
      !/^f(?:[0-9]+[A-Za-z-]*|cwd|err|jld|ltx|m[0-9]*|mem|NOFD|pd|rtd|txt)$/u.test(
        fields[0] ?? "",
      ) ||
      !/^t[^\0]+$/u.test(fields[1] ?? "")
    ) {
      throw new Error("Unix-socket descriptor evidence was malformed.");
    }
    if (fields[1]?.slice(1).toLowerCase() === "unix") descriptors += 1;
  }
  return descriptors;
}

function strictLsofLines(output: string, expectedPid: number): string[] {
  if (!output.endsWith("\n")) throw new Error("Process file evidence was truncated.");
  const lines = output.slice(0, -1).split("\n");
  const header = strictNulFields(lines[0] ?? "");
  if (header.length !== 1 || header[0] !== `p${expectedPid}`) {
    throw new Error("Process file evidence named an unexpected process.");
  }
  return lines;
}

function strictNulFields(line: string): string[] {
  if (!line.endsWith("\0")) return [];
  const fields = line.slice(0, -1).split("\0");
  return fields.some((field) => field.length === 0) ? [] : fields;
}

function defaultReadProcessArgv(pid: number): string[] | undefined {
  if (process.platform === "darwin") return undefined;
  const commandLine = readFileSync(`/proc/${pid}/cmdline`);
  if (commandLine.length === 0 || commandLine[commandLine.length - 1] !== 0) {
    throw new Error(`Process argv evidence was unavailable for PID ${pid}.`);
  }
  return commandLine.subarray(0, -1).toString("utf8").split("\0");
}

function defaultProcessExecutableMatches(
  pid: number,
  expectedPath: string,
  execFileStatus: (file: string, args: readonly string[]) => ExecFileStatus,
): boolean {
  const expected = realpathSync(expectedPath);
  const expectedIdentity = statSync(expected, { bigint: true });
  if (process.platform !== "darwin") {
    return realpathSync(readlinkSync(`/proc/${pid}/exe`)) === expected;
  }
  const result = execFileStatus(lsofPath, [
    "-nP",
    "-a",
    "-p",
    String(pid),
    "-d",
    "txt",
    "-F0pfnDi",
  ]);
  if (result.status !== 0 || result.stderr.trim().length !== 0) {
    throw new Error(`Executable provenance was unavailable for PID ${pid}.`);
  }
  const lines = strictLsofLines(result.stdout, pid);
  return lines.slice(1).some((line) => {
    const fields = strictNulFields(line);
    const device = fields[1];
    const inode = fields[2];
    const name = fields[3];
    if (
      fields.length !== 4 ||
      fields[0] !== "ftxt" ||
      device === undefined ||
      !/^D0x[0-9a-f]+$/iu.test(device) ||
      inode === undefined ||
      !/^i[1-9]\d*$/u.test(inode) ||
      name?.startsWith("n") !== true
    ) {
      return false;
    }
    try {
      return (
        realpathSync(name.slice(1)) === expected &&
        BigInt(device.slice(1)) === expectedIdentity.dev &&
        BigInt(inode.slice(1)) === expectedIdentity.ino
      );
    } catch {
      return false;
    }
  });
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
