import { readFile } from "node:fs/promises";
import {
  DebugBundleManifestSchema,
  DiagnosticDetailSchema,
  DiagnosticEvidenceIndexSchema,
  DiagnosticSnapshotSchema,
  DoctorReportSchema,
  LogRecordSchema,
  RedactionReportSchema,
  RetentionPolicySchema,
  STATION_SCHEMA_VERSION,
  TraceContextSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

const fixtureUrl = (path: string) =>
  new URL(`../../../../tests/contract-fixtures/diagnostics/${path}`, import.meta.url);

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl(path), "utf8"));
}

function expectParses(schema: ZodType, value: unknown, label: string) {
  const result = schema.safeParse(value);
  expect(result.success, `${label}: ${result.success ? "" : result.error.message}`).toBe(true);
}

describe("diagnostics schemas", () => {
  it("parses doctor, manifest, redaction, trace, log, and retention fixtures", async () => {
    expectParses(DoctorReportSchema, await loadJson("doctor-report.json"), "doctor report");
    expectParses(
      DebugBundleManifestSchema,
      await loadJson("debug-bundle-manifest.json"),
      "debug bundle manifest",
    );
    expectParses(
      RedactionReportSchema,
      await loadJson("redaction-report.json"),
      "redaction report",
    );
    expectParses(
      TraceContextSchema,
      { traceId: "trc_1", spanId: "spn_1", operation: "command.session.create" },
      "trace context",
    );
    expectParses(
      LogRecordSchema,
      {
        timestamp: "2026-05-20T12:00:00.000Z",
        level: "info",
        component: "observer",
        message: "Command accepted.",
        commandId: "cmd_1",
        traceId: "trc_1",
        spanId: "spn_1",
      },
      "log record",
    );
    expectParses(
      RetentionPolicySchema,
      ((await loadJson("doctor-report.json")) as { retention: unknown }).retention,
      "retention policy",
    );
  });

  it("parses a minimal diagnostic snapshot with trace-aware command and event records", () => {
    expectParses(
      DiagnosticSnapshotSchema,
      {
        schemaVersion: STATION_SCHEMA_VERSION,
        collectedAt: "2026-05-20T12:00:00.000Z",
        observerHealth: {
          schemaVersion: STATION_SCHEMA_VERSION,
          status: "healthy",
          pid: 1234,
          startedAt: "2026-05-20T12:00:00.000Z",
          version: "0.0.0",
        },
        snapshot: {
          schemaVersion: STATION_SCHEMA_VERSION,
          generatedAt: "2026-05-20T12:00:00.000Z",
          observer: {
            pid: 1234,
            startedAt: "2026-05-20T12:00:00.000Z",
            version: "0.0.0",
            healthy: true,
          },
          providerHealth: {},
          projects: [],
          rows: [],
          sessions: [],
          counts: {
            projects: 0,
            worktrees: 0,
            agents: 0,
            working: 0,
            idle: 0,
            attention: 0,
            unknown: 0,
          },
          alerts: [],
        },
        providerHealth: {},
        commands: [
          {
            id: "cmd_1",
            type: "observer.reconcile",
            command: { type: "observer.reconcile", payload: { reason: "schema" } },
            status: "succeeded",
            createdAt: "2026-05-20T12:00:00.000Z",
            traceId: "trc_1",
            spanId: "spn_1",
          },
        ],
        events: [
          {
            type: "command.succeeded",
            commandId: "cmd_1",
            traceId: "trc_1",
            spanId: "spn_1",
          },
        ],
        errors: [],
        logs: [],
      },
      "diagnostic snapshot",
    );
  });

  it("parses the diagnostic evidence index fixture", async () => {
    expectParses(
      DiagnosticEvidenceIndexSchema,
      await loadJson("diagnostic-evidence-index.json"),
      "diagnostic evidence index",
    );
  });

  it("parses provider-neutral worktree removal refusal evidence strictly", () => {
    const refusal = {
      type: "worktree_removal_refusal",
      provider: "worktrunk",
      projectId: "web",
      worktreeId: "wt_web_feature",
      canonicalPath: "/tmp/station/web/feature",
      observedBranch: "feature",
      refusalReason: "registration_changed",
    };

    expect(DiagnosticDetailSchema.parse(refusal)).toEqual(refusal);
    expect(
      DiagnosticDetailSchema.safeParse({ ...refusal, refusalReason: "provider_private_reason" })
        .success,
    ).toBe(false);
  });
});
