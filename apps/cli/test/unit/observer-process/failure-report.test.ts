import { PassThrough } from "node:stream";
import { OBSERVER_STARTUP_FAILURE_REPORT_MAX_BYTES, type SafeError } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createObserverStartupFailureReporter,
  normalizeObserverStartupFailure,
  OBSERVER_STARTUP_FAILURE_FD,
  parseObserverStartupFailureReport,
  readObserverStartupFailureReport,
  STATION_OBSERVER_STARTUP_FAILURE_FD,
  serializeObserverStartupFailureReport,
} from "../../../src/observerProcess/failureReport.js";

const typedCause: SafeError = {
  tag: "ObserverProcessEvidenceError",
  code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
  message: "Observer process evidence did not match the exact executable and argv.",
};

describe("Observer startup failure reports", () => {
  it("preserves SafeErrors and selects the deepest typed cause", () => {
    const inner = Object.assign(new Error(typedCause.message), typedCause);
    const outer = Object.assign(new Error("handoff refused", { cause: inner }), {
      tag: "ObserverHandoffError",
      code: "OBSERVER_HANDOFF_REFUSED",
      message: "The incumbent Observer could not be replaced safely.",
      hint: "Inspect ownership.",
    });

    expect(normalizeObserverStartupFailure(outer)).toEqual({
      kind: "observer-startup-failure",
      version: 1,
      error: {
        tag: "ObserverHandoffError",
        code: "OBSERVER_HANDOFF_REFUSED",
        message: "The incumbent Observer could not be replaced safely.",
        hint: "Inspect ownership.",
      },
      cause: typedCause,
    });
  });

  it("retains typed fields from a SafeError-shaped plain object and redacts them", () => {
    expect(
      normalizeObserverStartupFailure({
        ...typedCause,
        message: "Mismatch with API_TOKEN=super-secret-value",
        raw: { password: "do-not-copy" },
      }),
    ).toEqual({
      kind: "observer-startup-failure",
      version: 1,
      error: {
        ...typedCause,
        message: "Mismatch with API_TOKEN=[REDACTED]",
      },
    });
  });

  it("normalizes ordinary Errors to one redacted line without stacks", () => {
    const report = normalizeObserverStartupFailure(
      new Error("startup failed with API_TOKEN=super-secret-value\n    at private-frame"),
    );

    expect(report.error).toEqual({
      tag: "ObserverStartupCauseError",
      code: "OBSERVER_STARTUP_CAUSE_ERROR",
      message: "startup failed with API_TOKEN=[REDACTED]",
    });
    expect(JSON.stringify(report)).not.toContain("private-frame");
    expect(JSON.stringify(report)).not.toContain("super-secret-value");
  });

  it.each([
    undefined,
    null,
    false,
    42,
    "raw private value",
    { private: "value" },
  ])("normalizes arbitrary value %# without interpolation", (value) => {
    expect(normalizeObserverStartupFailure(value).error).toEqual({
      tag: "ObserverStartupCauseError",
      code: "OBSERVER_STARTUP_CAUSE_UNKNOWN",
      message: "Observer startup failed for an unknown reason.",
    });
  });

  it("terminates cyclic cause traversal", () => {
    const cyclic = new Error("cyclic");
    Object.defineProperty(cyclic, "cause", { value: cyclic });
    expect(normalizeObserverStartupFailure(cyclic).error.code).toBe("OBSERVER_STARTUP_CAUSE_ERROR");
  });

  it("normalizes objects whose cause cannot be inspected", () => {
    const inaccessibleCause = {};
    Object.defineProperty(inaccessibleCause, "cause", {
      get: () => {
        throw new Error("private getter failure");
      },
    });

    expect(normalizeObserverStartupFailure(inaccessibleCause).error).toEqual({
      tag: "ObserverStartupCauseError",
      code: "OBSERVER_STARTUP_CAUSE_UNKNOWN",
      message: "Observer startup failed for an unknown reason.",
    });
  });

  it("strictly serializes and parses exactly one bounded report", () => {
    const report = normalizeObserverStartupFailure(typedCause);
    const payload = serializeObserverStartupFailureReport(report);
    expect(parseObserverStartupFailureReport(payload)).toEqual(report);

    expect(() =>
      parseObserverStartupFailureReport(Buffer.from(`${payload.toString()}{}\n`)),
    ).toThrow("one complete JSON value");
    expect(() => parseObserverStartupFailureReport(Buffer.from('{"kind":'))).toThrow(
      "one complete JSON value",
    );
    expect(() =>
      parseObserverStartupFailureReport(
        Buffer.from(
          JSON.stringify({
            ...report,
            extra: true,
          }),
        ),
      ),
    ).toThrow("strict contract");
    expect(() =>
      parseObserverStartupFailureReport(
        Buffer.alloc(OBSERVER_STARTUP_FAILURE_REPORT_MAX_BYTES + 1),
      ),
    ).toThrow("byte limit");
  });

  it("reads one report and treats readiness EOF as absence", async () => {
    const failureStream = new PassThrough();
    const failureReader = readObserverStartupFailureReport(failureStream);
    failureStream.end(
      serializeObserverStartupFailureReport(normalizeObserverStartupFailure(typedCause)),
    );
    await expect(failureReader.report).resolves.toMatchObject({ error: typedCause });

    const readyStream = new PassThrough();
    const readyReader = readObserverStartupFailureReport(readyStream);
    readyStream.end();
    await expect(readyReader.report).resolves.toBeUndefined();
  });

  it("writes and closes once, including after a readiness notification", () => {
    const chunks: Buffer[] = [];
    const close = vi.fn();
    const env = {
      [STATION_OBSERVER_STARTUP_FAILURE_FD]: String(OBSERVER_STARTUP_FAILURE_FD),
    };
    const reporter = createObserverStartupFailureReporter(env, {
      write: (_fd, buffer, offset) => {
        const length = Math.min(7, buffer.byteLength - offset);
        chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
        return length;
      },
      close,
    });

    const report = reporter.failure(typedCause);
    reporter.failure(new Error("later failure"));
    reporter.ready();

    expect(env).not.toHaveProperty(STATION_OBSERVER_STARTUP_FAILURE_FD);
    expect(close).toHaveBeenCalledOnce();
    expect(parseObserverStartupFailureReport(Buffer.concat(chunks))).toEqual(report);

    const readyClose = vi.fn();
    const readyReporter = createObserverStartupFailureReporter(
      { [STATION_OBSERVER_STARTUP_FAILURE_FD]: String(OBSERVER_STARTUP_FAILURE_FD) },
      { write: vi.fn(() => 0), close: readyClose },
    );
    readyReporter.ready();
    readyReporter.ready();
    readyReporter.failure(typedCause);
    expect(readyClose).toHaveBeenCalledOnce();
  });
});
