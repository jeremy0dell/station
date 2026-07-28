import type { HarnessEventReport, ProviderHookEvent } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createHarnessHookAdapter,
  type HarnessHookAdapterSpec,
  type HarnessHookReportMapperInput,
} from "../../src/hookAdapter";

const now = "2026-05-27T12:00:00.000Z";

const baseEvent: ProviderHookEvent = {
  schemaVersion: STATION_SCHEMA_VERSION,
  provider: "fake-harness",
  kind: "harness",
  event: "TurnStarted",
  receivedAt: now,
};

function report(input: HarnessHookReportMapperInput): HarnessEventReport {
  const diagnostics: NonNullable<HarnessEventReport["diagnostics"]> = {
    rawEventType: input.eventType,
    compacted: input.diagnostics.compacted,
    truncated: input.diagnostics.truncated,
    omittedFieldNames: input.diagnostics.omittedFieldNames,
  };
  if (input.diagnostics.payloadBytes !== null) {
    diagnostics.payloadBytes = input.diagnostics.payloadBytes;
  }
  if (input.diagnostics.compactedBytes !== null) {
    diagnostics.compactedBytes = input.diagnostics.compactedBytes;
  }
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "fake-harness",
    kind: "harness",
    eventType: input.eventType,
    observedAt: input.observedAt,
    diagnostics,
  };
}

function adapterSpec(overrides: Partial<HarnessHookAdapterSpec> = {}): HarnessHookAdapterSpec {
  return {
    provider: "fake-harness",
    compactHookPayload: (event) => ({
      payload: event.payload,
      originalByteCount: 10,
      compactedByteCount: 8,
      compacted: true,
      omittedFieldNames: ["transcript"],
    }),
    hookPayloadToHarnessEventReport: report,
    ...overrides,
  };
}

function decideScope(spec: HarnessHookAdapterSpec, event: ProviderHookEvent) {
  const decide = createHarnessHookAdapter(spec).decideScope;
  if (decide === undefined) throw new Error("Expected the hook adapter to decide scope.");
  return decide(event);
}

describe("createHarnessHookAdapter", () => {
  it("admits non-harness events and station-owned harness events", () => {
    const spec = adapterSpec();

    expect(decideScope(spec, { ...baseEvent, kind: "terminal" })).toEqual({
      action: "accept",
      reason: "not-required",
    });
    expect(
      decideScope(spec, {
        ...baseEvent,
        payload: {
          station_session_id: "ses_task",
          station_worktree_id: "wt_task",
        },
      }),
    ).toEqual({ action: "accept", reason: "station-env" });
  });

  it("drops unlisted events before station identity admission", () => {
    const isForwardedEventType = vi.fn(() => false);
    const spec = adapterSpec({ isForwardedEventType });

    expect(
      decideScope(spec, {
        ...baseEvent,
        payload: {
          station_session_id: "ses_task",
          station_worktree_id: "wt_task",
        },
      }),
    ).toEqual({ action: "ignore", reason: "event-not-forwarded" });
    expect(isForwardedEventType).toHaveBeenCalledWith("TurnStarted");
  });

  it("admits cwd-only external sessions only when the provider opts in", () => {
    const event = { ...baseEvent, payload: { cwd: "/repo/task" } };

    expect(decideScope(adapterSpec({ acceptCwdFallback: true }), event)).toEqual({
      action: "accept",
      reason: "cwd",
    });
    expect(decideScope(adapterSpec(), event)).toEqual({
      action: "ignore",
      reason: "missing-station-env",
    });
  });

  it("withholds contradicted Codex-style identity while retaining cwd fallback", () => {
    const corroborateCwdMismatch = vi.fn(() => true);
    const spec = adapterSpec({
      acceptCwdFallback: true,
      corroborateCwdMismatch,
    });

    expect(
      decideScope(spec, {
        ...baseEvent,
        payload: {
          cwd: "/repo/other",
          station_session_id: "ses_task",
          station_worktree_id: "wt_task",
          station_worktree_path: "/repo/task",
          station_worktree_managed_root: "/repo/.worktrees",
        },
      }),
    ).toEqual({ action: "accept", reason: "cwd" });
    expect(corroborateCwdMismatch).toHaveBeenCalledWith(
      "/repo/other",
      "/repo/task",
      "/repo/.worktrees",
    );
  });

  it("compacts payloads into the shared summary shape", () => {
    const compactPayload = createHarnessHookAdapter(adapterSpec()).compactPayload;
    if (compactPayload === undefined) throw new Error("Expected payload compaction.");

    expect(compactPayload({ ...baseEvent, payload: { transcript: "large" } })).toEqual({
      event: { ...baseEvent, payload: { transcript: "large" } },
      payloadSummary: {
        present: true,
        originalBytes: 10,
        compactedBytes: 8,
        compacted: true,
        omittedFieldNames: ["transcript"],
      },
    });
  });

  it("builds reports with provider report ids and compaction diagnostics", () => {
    const hookPayloadToHarnessEventReport = vi.fn(report);
    const adapter = createHarnessHookAdapter(
      adapterSpec({
        hookPayloadReportId: (event) => `native:${event.event}`,
        hookPayloadToHarnessEventReport,
      }),
    );
    const toReport = adapter.toHarnessEventReport;
    if (toReport === undefined) throw new Error("Expected report normalization.");

    const result = toReport({
      event: baseEvent,
      payloadSummary: {
        present: true,
        originalBytes: 10,
        compactedBytes: 8,
        compacted: true,
        omittedFieldNames: ["transcript"],
      },
      fallbackReportId: () => "fallback",
    });

    expect(result).toMatchObject({ ok: true, report: { reportId: "native:TurnStarted" } });
    expect(hookPayloadToHarnessEventReport).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "TurnStarted",
        observedAt: now,
        diagnostics: {
          payloadBytes: 10,
          compactedBytes: 8,
          compacted: true,
          truncated: false,
          omittedFieldNames: ["transcript"],
        },
      }),
    );
  });

  it("uses hook or fallback ids and converts mapper failures into results", () => {
    const fallbackReportId = vi.fn(() => "fallback");
    const success = createHarnessHookAdapter(adapterSpec()).toHarnessEventReport?.({
      event: { ...baseEvent, hookId: "hook-native" },
      payloadSummary: {
        present: false,
        originalBytes: null,
        compactedBytes: null,
        compacted: false,
        omittedFieldNames: [],
      },
      fallbackReportId,
    });
    expect(success).toMatchObject({ ok: true, report: { reportId: "hook-native" } });
    expect(fallbackReportId).not.toHaveBeenCalled();

    const failure = createHarnessHookAdapter(
      adapterSpec({
        hookPayloadToHarnessEventReport: () => {
          throw new Error("invalid native payload");
        },
      }),
    ).toHarnessEventReport?.({
      event: baseEvent,
      payloadSummary: {
        present: false,
        originalBytes: null,
        compactedBytes: null,
        compacted: false,
        omittedFieldNames: [],
      },
      fallbackReportId,
    });
    expect(failure).toMatchObject({ ok: false, error: { message: "invalid native payload" } });
  });

  it("exposes Pi-style event normalization without changing the provider event", () => {
    const adapter = createHarnessHookAdapter(
      adapterSpec({ normalizeEventName: (event) => event.replaceAll("_", ".") }),
    );

    expect(adapter.normalizeEventName?.("turn_start")).toBe("turn.start");
    expect(baseEvent.event).toBe("TurnStarted");
  });
});
