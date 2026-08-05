import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type LogRecord, LogRecordSchema } from "@station/contracts";
import { redact } from "./redaction.js";

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
