import { type FileHandle, mkdir, open, writeFile } from "node:fs/promises";
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
};

export type CreateJsonlLoggerOptions = {
  component: LogRecord["component"];
  path: string;
  clock?: { now(): Date };
};

type JsonlSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export type ReverseJsonlReadOptions<T> = {
  maxBytes?: number;
  maxRecords?: number;
  matches?: (record: T) => boolean;
};

export type ReverseJsonlReadResult<T> = {
  records: T[];
  bytesRead: number;
  complete: boolean;
  invalidLines: number;
};

const jsonlChunkBytes = 64 * 1024;

export function componentLogPath(stateDir: string, component: LogRecord["component"]): string {
  const fileName = component === "hook" ? "hooks.jsonl" : `${component}.jsonl`;
  return join(stateDir, "logs", fileName);
}

export function createLogRecord(
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

  async function log(
    record: Omit<LogRecord, "timestamp" | "component"> & { timestamp?: string },
  ): Promise<LogRecord> {
    const parsed = createLogRecord({
      ...record,
      component: options.component,
      clock,
    });
    await appendJsonl(options.path, parsed);
    return parsed;
  }

  return {
    path: options.path,
    log,
    debug: (message, attributes) => log({ level: "debug", message, attributes }),
    info: (message, attributes) => log({ level: "info", message, attributes }),
    warn: (message, attributes) => log({ level: "warn", message, attributes }),
    error: (message, attributes) => log({ level: "error", message, attributes }),
  };
}

export async function appendJsonl(path: string, record: LogRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(record)}\n`, {
    flag: "a",
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readJsonlLog(path: string, maxRecords = 500): Promise<LogRecord[]> {
  const result = await readJsonlReverse(path, LogRecordSchema, { maxRecords });
  if (result.invalidLines > 0) throw new Error("Invalid JSONL log record.");
  return result.records;
}

export async function readJsonlReverse<T>(
  path: string,
  schema: JsonlSchema<T>,
  options: ReverseJsonlReadOptions<T> = {},
): Promise<ReverseJsonlReadResult<T>> {
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch {
    return { records: [], bytesRead: 0, complete: true, invalidLines: 0 };
  }

  const records: T[] = [];
  let bytesRead = 0;
  let invalidLines = 0;
  let stopped = false;
  let pending = Buffer.alloc(0);
  let hasRightBoundary = false;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;

  try {
    // Positional reads stop at the opened file's high-water mark, so concurrent appends wait for the next call.
    const highWater = (await file.stat()).size;
    let position = highWater;

    while (position > 0 && bytesRead < maxBytes && !stopped) {
      const length = Math.min(jsonlChunkBytes, position, maxBytes - bytesRead);
      const start = position - length;
      const chunk = Buffer.allocUnsafe(length);
      const read = await file.read(chunk, 0, length, start);
      position = start;
      bytesRead += read.bytesRead;
      const data = Buffer.concat([chunk.subarray(0, read.bytesRead), pending]);
      let right = data.length;

      let index = data.lastIndexOf(0x0a);
      while (index >= 0) {
        if (!hasRightBoundary) {
          hasRightBoundary = true;
          right = index;
        } else {
          const parsed = parseJsonlLine(data.subarray(index + 1, right), schema);
          if (parsed.invalid) invalidLines += 1;
          if (parsed.record !== undefined && (options.matches?.(parsed.record) ?? true)) {
            records.push(parsed.record);
            if (records.length >= maxRecords) {
              stopped = true;
              break;
            }
          }
          right = index;
        }
        index = index === 0 ? -1 : data.lastIndexOf(0x0a, index - 1);
      }

      pending = data.subarray(0, right);
      if (position === 0 && !stopped && hasRightBoundary) {
        const parsed = parseJsonlLine(pending, schema);
        if (parsed.invalid) invalidLines += 1;
        if (parsed.record !== undefined && (options.matches?.(parsed.record) ?? true)) {
          records.push(parsed.record);
        }
      }
    }

    return {
      records: records.slice(0, maxRecords).reverse(),
      bytesRead,
      complete: position === 0 && !stopped,
      invalidLines,
    };
  } finally {
    await file.close();
  }
}

function parseJsonlLine<T>(line: Buffer, schema: JsonlSchema<T>): { record?: T; invalid: boolean } {
  const source = line.toString("utf8");
  if (source.trim().length === 0) return { invalid: false };
  try {
    const parsed = schema.safeParse(JSON.parse(source));
    return parsed.success ? { record: parsed.data, invalid: false } : { invalid: true };
  } catch {
    return { invalid: true };
  }
}
