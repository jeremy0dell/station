import { type HarnessEventReport, STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createHarnessIngressQueue } from "../../src/hooks/harnessIngressQueue";

const now = "2026-05-20T12:00:00.000Z";
const clock = { now: () => new Date(now) };

describe("harness ingress queue", () => {
  it("drains reports that were scheduled but not yet processing", async () => {
    const processed: string[] = [];
    const queue = createHarnessIngressQueue({
      clock,
      processReport: async (report) => {
        processed.push(report.reportId);
        return { receipt: acceptedReceipt(report) };
      },
    });

    queue.enqueue(harnessReport("report_1"));
    await queue.drain();

    expect(processed).toEqual(["report_1"]);
    expect(queue.health()).toMatchObject({
      depth: 0,
      enqueued: 1,
      processed: 1,
      dropped: 0,
    });
  });

  it("rejects distinct reports beyond the pending queue cap", () => {
    const queue = createHarnessIngressQueue({
      clock,
      maxPendingReports: 1,
      processReport: async (report) => ({ receipt: acceptedReceipt(report) }),
    });

    const first = queue.enqueue(harnessReport("report_1", "session_1"));
    const second = queue.enqueue(harnessReport("report_2", "session_2"));

    expect(first).toMatchObject({ accepted: true, status: "accepted" });
    expect(second).toMatchObject({
      accepted: false,
      status: "rejected",
      error: {
        code: "HARNESS_INGRESS_QUEUE_FULL",
      },
    });
    expect(queue.health()).toMatchObject({
      depth: 1,
      enqueued: 1,
      dropped: 1,
      lastError: {
        code: "HARNESS_INGRESS_QUEUE_FULL",
      },
    });
  });

  it("keeps processing after a report throws", async () => {
    const processed: string[] = [];
    const queue = createHarnessIngressQueue({
      clock,
      processReport: async (report) => {
        if (report.reportId === "report_1") {
          throw new Error("projection failed");
        }
        processed.push(report.reportId);
        return { receipt: acceptedReceipt(report) };
      },
    });

    queue.enqueue(harnessReport("report_1", "session_1"));
    queue.enqueue(harnessReport("report_2", "session_2"));
    await queue.drain();

    expect(processed).toEqual(["report_2"]);
    expect(queue.health()).toMatchObject({
      depth: 0,
      processed: 1,
      failed: 1,
      lastError: {
        code: "HARNESS_INGRESS_PROCESS_FAILED",
      },
    });
  });

  it("does not coalesce reports from different native sessions sharing Station identity", async () => {
    const started = deferred();
    const release = deferred();
    const processed: string[] = [];
    const queue = createHarnessIngressQueue({
      clock,
      processReport: async (report) => {
        if (report.reportId === "report_blocker") {
          started.resolve();
          await release.promise;
        }
        processed.push(report.reportId);
        return { receipt: acceptedReceipt(report) };
      },
    });

    queue.enqueue(harnessReport("report_blocker", "session_blocker"));
    await started.promise;
    queue.enqueue(harnessReport("report_native_a", "session_shared", "native_a"));
    queue.enqueue(harnessReport("report_native_b", "session_shared", "native_b"));
    release.resolve();
    await queue.drain();

    expect(processed).toEqual(["report_blocker", "report_native_a", "report_native_b"]);
    expect(queue.health()).toMatchObject({ coalesced: 0, processed: 3 });
  });

  it("waits for active work during shutdown and rejects later enqueue", async () => {
    const started = deferred();
    const release = deferred();
    const processed: string[] = [];
    const queue = createHarnessIngressQueue({
      clock,
      processReport: async (report) => {
        started.resolve();
        await release.promise;
        processed.push(report.reportId);
        return { receipt: acceptedReceipt(report) };
      },
    });

    queue.enqueue(harnessReport("report_1"));
    await started.promise;

    const shutdown = queue.shutdown();
    const rejected = queue.enqueue(harnessReport("report_2", "session_2"));
    expect(rejected).toMatchObject({
      accepted: false,
      status: "rejected",
      error: {
        code: "HARNESS_INGRESS_QUEUE_SHUTTING_DOWN",
      },
    });

    release.resolve();
    await shutdown;

    expect(processed).toEqual(["report_1"]);
    expect(queue.health()).toMatchObject({
      depth: 0,
      processed: 1,
      dropped: 1,
    });
  });
});

function harnessReport(
  reportId: string,
  sessionId = "session_1",
  nativeSessionId?: string,
): HarnessEventReport {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId,
    provider: "codex",
    kind: "harness",
    eventType: "PreToolUse",
    observedAt: now,
    status: {
      value: "working",
      confidence: "medium",
      reason: "Codex is about to use Bash.",
      source: "harness_event",
      updatedAt: now,
    },
    correlation: {
      sessionId,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    },
    coalesceKey: "turn:turn_1:tool:Bash",
  };
}

function acceptedReceipt(report: HarnessEventReport) {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: report.reportId,
    provider: report.provider,
    eventType: report.eventType,
    accepted: true,
    status: "accepted" as const,
    receivedAt: now,
    projected: false,
    scheduledReconcile: false,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
