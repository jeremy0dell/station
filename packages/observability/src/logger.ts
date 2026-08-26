import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type LogComponent,
  type LogRecord,
  LogRecordSchema,
  type RetentionPolicy,
} from "@station/contracts";
import { redact, redactCliInvocationRecord } from "./redaction.js";
import { discoverComponentLogFiles, pruneRotatedComponentLogs } from "./retention.js";

const MAX_CLI_INVOCATION_RECORD_BYTES = 32 * 1024;
const MAX_BOUNDED_LOG_FILE_BYTES = 16 * 1024 * 1024;

export type JsonlLogger = {
  path: string;
  log(
    record: Omit<LogRecord, "timestamp" | "component"> & { timestamp?: string },
  ): Promise<LogRecord>;
  debug(message: string, attributes?: Record<string, unknown>): Promise<LogRecord>;
  info(message: string, attributes?: Record<string, unknown>): Promise<LogRecord>;
  warn(message: string, attributes?: Record<string, unknown>): Promise<LogRecord>;
  error(message: string, attributes?: Record<string, unknown>): Promise<LogRecord>;
  /** Wait for every write already accepted by this logger. */
  flush?(): Promise<void>;
};

export type CreateJsonlLoggerOptions = {
  component: LogRecord["component"];
  path: string;
  clock?: { now(): Date };
};

const appendQueues = new Map<string, Promise<void>>();

export function componentLogPath(stateDir: string, component: LogRecord["component"]): string {
  const fileName = component === "hook" ? "hooks.jsonl" : `${component}.jsonl`;
  return join(stateDir, "logs", fileName);
}

export type DurableCliInvocationAppendResult = {
  record: LogRecord;
  rotated: boolean;
  cleanupFailures: number;
};

export type BoundedLogReadEvidence = {
  filesSearched: string[];
  malformedLines: number;
  unreadableFiles: number;
  truncatedFiles: number;
};

export type BoundedLogReadResult = {
  records: LogRecord[];
  files: Array<{ path: string; records: LogRecord[] }>;
  evidence: BoundedLogReadEvidence;
};

type DurableCliInvocationFileHandle = {
  stat(): Promise<{ isFile(): boolean }>;
  chmod(mode: number): Promise<unknown>;
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<unknown>;
  close(): Promise<unknown>;
};

export async function appendDurableCliInvocationRecord(options: {
  stateDir: string;
  policy: RetentionPolicy;
  record: LogRecord;
  now?: Date;
  openFile?: (path: string, flags: number, mode: number) => Promise<DurableCliInvocationFileHandle>;
}): Promise<DurableCliInvocationAppendResult> {
  const record = redactCliInvocationRecord(options.record);
  if (record.component !== "cli" || record.cliInvocation === undefined) {
    throw new Error("Durable CLI invocation append requires a strict CLI lifecycle record.");
  }
  const buffer = Buffer.from(`\n${JSON.stringify(record)}\n`, "utf8");
  if (buffer.byteLength > MAX_CLI_INVOCATION_RECORD_BYTES) {
    throw new Error("CLI invocation lifecycle record exceeds the durable append limit.");
  }

  const path = componentLogPath(options.stateDir, "cli");
  const logDir = dirname(path);
  await ensurePrivateLogDirectory(logDir);
  const active = await regularFileStat(path);
  const rotationLimit =
    Math.min(options.policy.maxFileMb, options.policy.components.cliMaxMb) * 1024 * 1024;
  let rotated = false;
  if (active !== undefined && Number(active.size) + buffer.byteLength > rotationLimit) {
    const lifecycle = record.cliInvocation;
    const rotatedPath = join(
      logDir,
      `cli.${rotationTimestamp(options.now ?? new Date())}.${process.pid}.${lifecycle.invocationId}.jsonl`,
    );
    try {
      await rename(path, rotatedPath);
      await enforcePrivateRegularFile(rotatedPath);
      await syncDirectory(logDir);
      rotated = true;
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) {
        throw new Error("CLI invocation log rotation failed.", { cause: error });
      }
    }
  }

  const existedBeforeOpen = (await regularFileStat(path)) !== undefined;
  const handle = await (options.openFile ?? open)(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let appendError: unknown;
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error("CLI invocation log target is not a regular file.");
    }
    await handle.chmod(0o600);
    const written = await handle.write(buffer, 0, buffer.byteLength, null);
    if (written.bytesWritten !== buffer.byteLength) {
      throw new Error("CLI invocation log append was partial.");
    }
    await handle.sync();
  } catch (error) {
    appendError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    appendError ??= error;
  }
  if (appendError !== undefined) {
    throw new Error("CLI invocation log append was not durable.", { cause: appendError });
  }
  if (!existedBeforeOpen) {
    await syncDirectory(logDir);
  }

  const cleanup = await pruneRotatedComponentLogs({
    stateDir: options.stateDir,
    component: "cli",
    policy: options.policy,
    ...(options.now === undefined ? {} : { now: options.now }),
  }).catch(() => ({ deleted: 0, failures: 1 }));
  return { record, rotated, cleanupFailures: cleanup.failures };
}

export async function readBoundedComponentLogs(options: {
  stateDir: string;
  component: LogComponent;
  maxRecords?: number;
  maxRotatedFiles?: number;
  maxBytesPerFile?: number;
}): Promise<BoundedLogReadResult> {
  const fileSet = await discoverComponentLogFiles(
    options.stateDir,
    options.component,
    options.maxRotatedFiles ?? 32,
  );
  const paths = [...fileSet.rotatedPaths].reverse();
  paths.push(fileSet.activePath);
  const evidence: BoundedLogReadEvidence = {
    filesSearched: paths,
    malformedLines: 0,
    unreadableFiles: 0,
    truncatedFiles: 0,
  };
  const entries: Array<{ path: string; record: LogRecord }> = [];
  for (const path of paths) {
    const read = await readBoundedLogFile(
      path,
      options.maxBytesPerFile ?? MAX_BOUNDED_LOG_FILE_BYTES,
    );
    if (read.status === "unreadable") {
      evidence.unreadableFiles += 1;
      continue;
    }
    if (read.status === "missing") continue;
    if (read.truncated) evidence.truncatedFiles += 1;
    for (const line of read.source.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = LogRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) {
          entries.push({ path, record: parsed.data });
          if (entries.length > 500) entries.splice(0, entries.length - 500);
        } else evidence.malformedLines += 1;
      } catch {
        evidence.malformedLines += 1;
      }
    }
  }
  entries.sort(
    (left, right) => Date.parse(left.record.timestamp) - Date.parse(right.record.timestamp),
  );
  const maxRecords = Math.max(0, Math.min(options.maxRecords ?? 500, 500));
  const selected = entries.slice(Math.max(0, entries.length - maxRecords));
  return {
    records: selected.map((entry) => entry.record),
    files: paths.flatMap((path) => {
      const records = selected.filter((entry) => entry.path === path).map((entry) => entry.record);
      return records.length === 0 ? [] : [{ path, records }];
    }),
    evidence,
  };
}

function createLogRecord(
  input: Omit<LogRecord, "timestamp"> & { timestamp?: string; clock?: { now(): Date } },
): LogRecord {
  const { clock, attributes, ...record } = input;
  const redacted = redact(attributes ?? {}, clock?.now());
  return LogRecordSchema.parse({
    ...record,
    timestamp: input.timestamp ?? clock?.now().toISOString() ?? new Date().toISOString(),
    ...(Object.keys(redacted.value as Record<string, unknown>).length === 0
      ? {}
      : { attributes: redacted.value }),
  });
}

export function createJsonlLogger(options: CreateJsonlLoggerOptions): JsonlLogger {
  const clock = options.clock ?? { now: () => new Date() };
  let latestWrite = Promise.resolve();

  async function log(
    record: Omit<LogRecord, "timestamp" | "component"> & { timestamp?: string },
  ): Promise<LogRecord> {
    const parsed = createLogRecord({
      ...record,
      component: options.component,
      clock,
    });
    latestWrite = appendJsonl(options.path, parsed);
    await latestWrite;
    return parsed;
  }

  return {
    path: options.path,
    log,
    debug: (message, attributes) => log({ level: "debug", message, attributes }),
    info: (message, attributes) => log({ level: "info", message, attributes }),
    warn: (message, attributes) => log({ level: "warn", message, attributes }),
    error: (message, attributes) => log({ level: "error", message, attributes }),
    flush: () => latestWrite,
  };
}

async function appendJsonl(path: string, record: LogRecord): Promise<void> {
  const previous = appendQueues.get(path) ?? Promise.resolve();
  const next = appendAfter(previous, path, record);
  appendQueues.set(path, next);
  try {
    await next;
  } finally {
    if (appendQueues.get(path) === next) {
      appendQueues.delete(path);
    }
  }
}

async function appendAfter(
  previous: Promise<void>,
  path: string,
  record: LogRecord,
): Promise<void> {
  try {
    await previous;
  } catch {
    // A failed write must not prevent later lifecycle evidence from reaching the log.
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(record)}\n`, {
    flag: "a",
    encoding: "utf8",
    mode: 0o600,
  });
}

async function ensurePrivateLogDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(path);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("CLI invocation log directory is not a regular directory.");
  }
  await chmod(path, 0o700);
}

async function regularFileStat(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error("CLI invocation log target is not a regular file.");
    }
    return fileStat;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function enforcePrivateRegularFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error("CLI invocation rotated log target is not a regular file.");
    }
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

function rotationTimestamp(now: Date): string {
  return now.toISOString().replaceAll(":", "-");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readBoundedLogFile(
  path: string,
  maxBytes: number,
): Promise<
  | { status: "ok"; source: string; truncated: boolean }
  | { status: "missing" }
  | { status: "unreadable" }
> {
  let fileStat: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return { status: "unreadable" };
  } catch (error) {
    return isNodeErrorCode(error, "ENOENT") ? { status: "missing" } : { status: "unreadable" };
  }
  const boundedBytes = Math.max(1, Math.min(maxBytes, MAX_BOUNDED_LOG_FILE_BYTES));
  const start = Math.max(0, fileStat.size - boundedBytes);
  const length = Math.min(fileStat.size, boundedBytes);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { status: "unreadable" };
  }
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    let source = buffer.subarray(0, result.bytesRead).toString("utf8");
    if (start > 0) {
      const firstLineBreak = source.indexOf("\n");
      source = firstLineBreak === -1 ? "" : source.slice(firstLineBreak + 1);
    }
    return { status: "ok", source, truncated: start > 0 };
  } catch {
    return { status: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readJsonlLog(path: string, maxRecords = 500): Promise<LogRecord[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const records: LogRecord[] = [];
  for (const line of source.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new Error("A structured log line was not valid JSON.", { cause });
    }
    const parsed = LogRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("A structured log line did not match the LogRecord contract.", {
        cause: parsed.error,
      });
    }
    records.push(parsed.data);
  }

  return records.slice(Math.max(0, records.length - maxRecords));
}
