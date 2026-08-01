import type { LogRecord } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  assessCauseEvidence,
  diagnosticEvidenceRoles,
  extractDiagnosticMatchEvidence,
  projectDiagnosticContext,
  projectOperationalBoundaryEvidence,
  retainedFailureSignal,
} from "../../src/commands/diagnosticEvidence.js";

const record: LogRecord = {
  timestamp: "2026-07-18T13:55:39.044Z",
  level: "error",
  component: "cli",
  message: "Observer lifecycle failed.",
  attributes: {
    operation: "cli.observer.start",
    kind: "replacement_char",
    startupTail: "Persistence initialization failed: SQLITE_BUSY database is locked.",
    error: {
      code: "OBSERVER_EXITED_ON_START",
      message: "Observer exited before becoming healthy.",
    },
    nested: { reason: "database is locked" },
    oversized: "x".repeat(200),
  },
};

describe("diagnostic evidence projection", () => {
  it("reserves explicit root-cause status for correlated diagnostic-index declarations", () => {
    expect(
      assessCauseEvidence({
        explicitRootCauseCodes: ["SQLITE_BUSY"],
        observedFailureCodes: ["OBSERVER_EXITED_ON_START"],
        matched: true,
        searchComplete: true,
        invalidLines: 0,
        reportingBoundaryOnly: true,
      }),
    ).toEqual({
      status: "explicit_root_cause",
      explicitRootCauseCodes: ["SQLITE_BUSY"],
      observedFailureCodes: ["OBSERVER_EXITED_ON_START"],
      limitations: ["reporting_boundary_only"],
    });
  });

  it("classifies a generic wrapper error as an observed failure with limitations", () => {
    expect(
      assessCauseEvidence({
        explicitRootCauseCodes: [],
        observedFailureCodes: ["OBSERVER_START_FAILED"],
        matched: true,
        searchComplete: false,
        invalidLines: 2,
        reportingBoundaryOnly: true,
      }),
    ).toEqual({
      status: "observed_failure",
      explicitRootCauseCodes: [],
      observedFailureCodes: ["OBSERVER_START_FAILED"],
      limitations: [
        "no_explicit_root_cause",
        "reporting_boundary_only",
        "incomplete_search",
        "invalid_evidence",
      ],
    });
  });

  it("classifies only retained corruption kinds as observed failure signals", () => {
    expect(retainedFailureSignal("replacement_char")).toBe("replacement_char");
    expect(retainedFailureSignal("harness")).toBeUndefined();
    expect(
      assessCauseEvidence({
        explicitRootCauseCodes: [],
        observedFailureCodes: [],
        observedFailureSignals: ["replacement_char"],
        matched: true,
        searchComplete: true,
        invalidLines: 0,
        reportingBoundaryOnly: true,
      }),
    ).toEqual({
      status: "observed_failure",
      explicitRootCauseCodes: [],
      observedFailureCodes: [],
      observedFailureSignals: ["replacement_char"],
      limitations: ["no_explicit_root_cause", "reporting_boundary_only"],
    });
  });

  it("treats an exactly matched warning record as an observed proximate failure", () => {
    expect(
      assessCauseEvidence({
        explicitRootCauseCodes: [],
        observedFailureCodes: [],
        observedFailureRecord: true,
        matched: true,
        searchComplete: true,
        invalidLines: 0,
        reportingBoundaryOnly: true,
      }),
    ).toMatchObject({
      status: "observed_failure",
      limitations: ["no_explicit_root_cause", "reporting_boundary_only"],
    });
  });

  it("distinguishes matched success and absent evidence", () => {
    expect(
      assessCauseEvidence({
        explicitRootCauseCodes: [],
        observedFailureCodes: [],
        matched: true,
        commandStatus: "succeeded",
        searchComplete: true,
        invalidLines: 0,
        reportingBoundaryOnly: false,
      }).status,
    ).toBe("matched_success");
    expect(
      assessCauseEvidence({
        explicitRootCauseCodes: [],
        observedFailureCodes: [],
        matched: false,
        searchComplete: true,
        invalidLines: 0,
        reportingBoundaryOnly: false,
      }),
    ).toMatchObject({
      status: "insufficient_evidence",
      limitations: ["no_explicit_root_cause"],
    });
  });

  it("returns deterministic bounded evidence for nested values and matching keys", () => {
    expect(extractDiagnosticMatchEvidence(record, "SQLITE_BUSY")).toEqual([
      {
        path: "/attributes/startupTail",
        excerpt: "Persistence initialization failed: SQLITE_BUSY database is locked.",
      },
    ]);
    expect(extractDiagnosticMatchEvidence(record, "reason")).toEqual([
      { path: "/attributes/nested/reason", excerpt: "reason: database is locked" },
    ]);
  });

  it("caps match count and clips Unicode by code point", () => {
    const many: LogRecord = {
      ...record,
      attributes: {
        a: `before ${"🧭".repeat(200)} needle after`,
        b: "needle two",
        c: "needle three",
        d: "needle four",
      },
    };
    const evidence = extractDiagnosticMatchEvidence(many, "needle");
    expect(evidence).toHaveLength(3);
    expect(evidence.map((item) => item.path)).toEqual([
      "/attributes/a",
      "/attributes/b",
      "/attributes/c",
    ]);
    expect([...(evidence[0]?.excerpt ?? "")].length).toBeLessThanOrEqual(160);
    expect(evidence[0]?.excerpt).toContain("needle");
  });

  it("projects bounded scalar context while excluding duplicated and oversized fields", () => {
    expect(projectDiagnosticContext(record)).toEqual([
      { path: "/attributes/kind", value: "replacement_char" },
      { path: "/attributes/operation", value: "cli.observer.start" },
    ]);
  });

  it("labels operational facts and logging provenance with distinct evidence roles", () => {
    expect(diagnosticEvidenceRoles()).toEqual({
      operationalBoundaryEvidence: "failure_and_ownership_evidence",
      component: "logging_location_only",
    });
  });

  it("groups retained operational facts without inferring an owner", () => {
    const evidence = projectOperationalBoundaryEvidence({
      operation: "cli.observer.start",
      commandType: "worktree.remove",
      signalKind: "replacement_char",
      recordSummary: "Local git metadata refresh failed.",
      errorCode: "LOCAL_GIT_REF_UNRESOLVED",
      errorMessage: "The worktree ref could not be resolved.",
    });
    expect(evidence).toEqual({
      operation: "cli.observer.start",
      commandType: "worktree.remove",
      signalKind: "replacement_char",
      recordSummary: "Local git metadata refresh failed.",
      errorCode: "LOCAL_GIT_REF_UNRESOLVED",
      errorMessage: "The worktree ref could not be resolved.",
    });
    expect(projectOperationalBoundaryEvidence({})).toBeUndefined();
    const bounded = projectOperationalBoundaryEvidence({
      recordSummary: "🧭".repeat(300),
    })?.recordSummary;
    expect([...(bounded ?? "")]).toHaveLength(240);
    expect(bounded).toMatch(/…$/u);
  });
});
