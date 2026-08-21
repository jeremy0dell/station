import { closeSync, writeSync } from "node:fs";
import type { Readable } from "node:stream";
import {
  OBSERVER_STARTUP_FAILURE_REPORT_MAX_BYTES,
  type ObserverStartupFailureReport,
  ObserverStartupFailureReportSchema,
  type SafeError,
  SafeErrorSchema,
} from "@station/contracts";
import { redact } from "@station/observability";
import type { ObserverStartupReadinessSink } from "@station/observer";
import { z } from "zod";

/** Private inherited descriptor used only for one child startup failure report. */
export const STATION_OBSERVER_STARTUP_FAILURE_FD = "STATION_OBSERVER_STARTUP_FAILURE_FD";

/** The private report descriptor is fixed so process evidence retains a stable argv. */
export const OBSERVER_STARTUP_FAILURE_FD = 3;

const SafeErrorViewSchema = SafeErrorSchema.strip();
const CauseCarrierSchema = z.object({ cause: z.unknown() }).passthrough();

type ObserverStartupFailureReporterDeps = {
  write?: (fd: number, buffer: Uint8Array, offset: number) => number;
  close?: (fd: number) => void;
};

export type ObserverStartupFailureReporter = ObserverStartupReadinessSink & {
  failure(error: unknown): ObserverStartupFailureReport;
};

export type ObserverStartupFailureReportReader = {
  report: Promise<ObserverStartupFailureReport | undefined>;
  dispose(): void;
};

/**
 * ADAPTER
 *
 * Writes at most one strict, redacted Observer startup failure to the inherited
 * report descriptor and closes the descriptor on either readiness or failure.
 */
export function createObserverStartupFailureReporter(
  env: NodeJS.ProcessEnv = process.env,
  deps: ObserverStartupFailureReporterDeps = {},
): ObserverStartupFailureReporter {
  const configuredFd = env[STATION_OBSERVER_STARTUP_FAILURE_FD];
  delete env[STATION_OBSERVER_STARTUP_FAILURE_FD];
  const fd =
    configuredFd === String(OBSERVER_STARTUP_FAILURE_FD) ? OBSERVER_STARTUP_FAILURE_FD : undefined;
  const write = deps.write ?? ((targetFd, buffer, offset) => writeSync(targetFd, buffer, offset));
  const close = deps.close ?? closeSync;
  let closed = fd === undefined;

  const closeOnce = (): void => {
    if (closed || fd === undefined) return;
    closed = true;
    try {
      close(fd);
    } catch {
      // Failure reporting is best-effort and must not replace the startup result.
    }
  };

  return {
    ready: closeOnce,
    failure: (error) => {
      let report = normalizeObserverStartupFailure(error);
      if (!closed && fd !== undefined) {
        try {
          let payload: Uint8Array;
          try {
            payload = serializeObserverStartupFailureReport(report);
          } catch {
            report = unknownObserverStartupFailureReport();
            payload = serializeObserverStartupFailureReport(report);
          }
          let offset = 0;
          while (offset < payload.byteLength) {
            const written = write(fd, payload, offset);
            if (written <= 0) throw new Error("Observer startup failure report write stalled.");
            offset += written;
          }
        } catch {
          // The original startup failure remains authoritative if the private pipe is unavailable.
        } finally {
          closeOnce();
        }
      }
      return report;
    },
  };
}

/**
 * ADAPTER
 *
 * Consumes one bounded inherited-pipe payload and validates the strict private
 * child report before exposing typed failure evidence to lifecycle orchestration.
 */
export function readObserverStartupFailureReport(
  stream: Readable,
): ObserverStartupFailureReportReader {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  let resolveReport!: (report: ObserverStartupFailureReport | undefined) => void;
  let rejectReport!: (error: Error) => void;
  const report = new Promise<ObserverStartupFailureReport | undefined>((resolve, reject) => {
    resolveReport = resolve;
    rejectReport = reject;
  });

  const cleanup = (): void => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("error", onError);
    stream.off("close", onClose);
  };
  const resolve = (value: ObserverStartupFailureReport | undefined): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveReport(value);
  };
  const reject = (error: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectReport(error);
  };
  const onData = (chunk: Buffer | string): void => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buffer.byteLength;
    if (bytes > OBSERVER_STARTUP_FAILURE_REPORT_MAX_BYTES) {
      reject(new Error("Observer startup failure report exceeded its byte limit."));
      stream.destroy();
      return;
    }
    chunks.push(buffer);
  };
  const onEnd = (): void => {
    if (bytes === 0) {
      resolve(undefined);
      return;
    }
    try {
      resolve(parseObserverStartupFailureReport(Buffer.concat(chunks, bytes)));
    } catch (error) {
      reject(
        error instanceof Error ? error : new Error("Observer startup failure report was invalid."),
      );
    }
  };
  const onError = (error: Error): void => reject(error);
  const onClose = (): void => {
    if (!settled) reject(new Error("Observer startup failure report ended before EOF."));
  };

  stream.on("data", onData);
  stream.once("end", onEnd);
  stream.once("error", onError);
  stream.once("close", onClose);

  return {
    report,
    dispose: () => {
      if (settled) return;
      resolve(undefined);
      stream.destroy();
    },
  };
}

/** Serializes one strict report and rejects output over the inherited-pipe byte limit. */
export function serializeObserverStartupFailureReport(
  report: ObserverStartupFailureReport,
): Uint8Array {
  const parsed = ObserverStartupFailureReportSchema.parse(report);
  const payload = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
  if (payload.byteLength > OBSERVER_STARTUP_FAILURE_REPORT_MAX_BYTES) {
    throw new Error("Observer startup failure report exceeded its byte limit.");
  }
  return payload;
}

/** Parses exactly one strict report from a bounded pipe payload. */
export function parseObserverStartupFailureReport(
  payload: Uint8Array,
): ObserverStartupFailureReport {
  if (payload.byteLength > OBSERVER_STARTUP_FAILURE_REPORT_MAX_BYTES) {
    throw new Error("Observer startup failure report exceeded its byte limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    throw new Error("Observer startup failure report was not one complete JSON value.");
  }
  const parsed = ObserverStartupFailureReportSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Observer startup failure report did not match its strict contract.");
  }
  return parsed.data;
}

/** Normalizes one unknown startup escape without retaining raw objects, stacks, or serialization. */
export function normalizeObserverStartupFailure(error: unknown): ObserverStartupFailureReport {
  try {
    const chain = startupFailureChain(error);
    const report: ObserverStartupFailureReport = {
      kind: "observer-startup-failure",
      version: 1,
      error: normalizeStartupFailureNode(chain[0]),
    };
    const deepestTyped = [...chain].reverse().find((node) => safeErrorView(node) !== undefined);
    const causeNode =
      deepestTyped !== undefined && deepestTyped !== chain[0]
        ? deepestTyped
        : chain.length > 1
          ? chain[chain.length - 1]
          : undefined;
    if (causeNode !== undefined) {
      report.cause = normalizeStartupFailureNode(causeNode);
    }
    return ObserverStartupFailureReportSchema.parse(report);
  } catch {
    return unknownObserverStartupFailureReport();
  }
}

function startupFailureChain(error: unknown): unknown[] {
  const chain: unknown[] = [error];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    let carrier: ReturnType<typeof CauseCarrierSchema.safeParse>;
    try {
      carrier = CauseCarrierSchema.safeParse(current);
    } catch {
      break;
    }
    if (!carrier.success || carrier.data.cause === undefined || seen.has(carrier.data.cause)) break;
    current = carrier.data.cause;
    chain.push(current);
  }
  return chain;
}

function normalizeStartupFailureNode(value: unknown): SafeError {
  const safeError = safeErrorView(value);
  if (safeError !== undefined) {
    return SafeErrorSchema.parse(redact(safeError).value);
  }
  if (value instanceof Error) {
    const [firstLine] = redact(value.message).value.split(/\r?\n/u);
    return {
      tag: "ObserverStartupCauseError",
      code: "OBSERVER_STARTUP_CAUSE_ERROR",
      message:
        firstLine === undefined || firstLine.length === 0 ? "Observer startup failed." : firstLine,
    };
  }
  return unknownObserverStartupFailureReport().error;
}

function safeErrorView(value: unknown): SafeError | undefined {
  try {
    const parsed = SafeErrorViewSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function unknownObserverStartupFailureReport(): ObserverStartupFailureReport {
  return {
    kind: "observer-startup-failure",
    version: 1,
    error: {
      tag: "ObserverStartupCauseError",
      code: "OBSERVER_STARTUP_CAUSE_UNKNOWN",
      message: "Observer startup failed for an unknown reason.",
    },
  };
}
