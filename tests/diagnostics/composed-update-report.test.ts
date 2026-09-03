import { describe, expect, it } from "vitest";

async function loadReportModule() {
  return import("../../scripts/test-runners/composed-update-report.mjs");
}

function legacyReport() {
  return {
    schemaVersion: 1,
    channel: "installer-binary",
    status: "planned",
    current: { version: "0.0.0-pre-alpha.5.16" },
    target: { version: "0.0.1-local" },
    steps: [
      { id: "detect", status: "completed", detail: "Detected installer ownership." },
      { id: "plan", status: "completed", detail: "Resolved the target." },
      { id: "apply", status: "planned", detail: "Would install the target." },
      { id: "observer-restart", status: "planned", detail: "Would restart the Observer." },
      { id: "host-handoff", status: "skipped", detail: "No Host is running." },
    ],
    warnings: [],
    recoveryCommands: [],
  };
}

function currentReport() {
  return {
    schemaVersion: 5,
    kind: "result",
    channel: "installer-binary",
    status: "failed",
    current: { version: "0.0.0-local" },
    target: { version: "0.0.0-local" },
    initial: {
      schemaVersion: 1,
      boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
      installed: { version: "0.0.0-local" },
      target: { version: "0.0.0-local" },
      observer: { status: "absent" },
      host: { status: "absent" },
      parkedBridges: {
        status: "assessed",
        totalParkedCount: 0,
        unownedParkedCount: 0,
        adoptionRequiredCount: 0,
      },
      hookProviderIds: [],
      hooks: [],
      terminalDispositions: [],
      evidenceComplete: false,
    },
    plan: {
      authorization: "none",
      selectedTarget: {
        artifact: { version: "0.0.0-local" },
        runtimeBuild: { status: "not-yet-provable" },
      },
      outcome: "actionable",
      phases: {
        artifactApplication: {
          action: "no-op",
          reason: "selected-artifact-current",
          before: { version: "0.0.0-local" },
          owner: "installer-binary",
          command: { kind: "none" },
        },
        hookReconciliation: { action: "no-op", reason: "healthy", providers: [] },
        observerConvergence: { action: "start", reason: "absent" },
        terminalConvergence: { action: "no-op", reason: "no-terminals", terminals: [] },
        hostConvergence: { action: "no-op", reason: "absent" },
        persistedStateReconcile: { action: "run", reason: "runtime-change" },
        finalVerification: { action: "inspect", reason: "after-actions" },
      },
    },
    steps: [],
    warnings: [],
    recoveryCommands: [],
    hookReconciliations: [],
  };
}

describe("composed update report parsing", () => {
  it("accepts the strict published-predecessor report", async () => {
    const { parseComposedUpdateReport } = await loadReportModule();
    const report = legacyReport();

    expect(parseComposedUpdateReport(report, "0.0.0-pre-alpha.5.16")).toEqual(report);
    expect(() =>
      parseComposedUpdateReport({ ...report, unknown: true }, "0.0.0-pre-alpha.5.16"),
    ).toThrow();
    expect(() =>
      parseComposedUpdateReport(
        {
          ...report,
          steps: [{ ...report.steps[0], detail: "Unsafe detail.\n    at legacy-frame" }],
        },
        "0.0.0-pre-alpha.5.16",
      ),
    ).toThrow();
  });

  it("delegates current reports to the current shared contract", async () => {
    const { parseComposedUpdateReport } = await loadReportModule();
    const report = currentReport();

    expect(parseComposedUpdateReport(report, "0.0.0-local")).toEqual(report);
    expect(() =>
      parseComposedUpdateReport({ ...report, status: "planned" }, "0.0.0-local"),
    ).toThrow();
  });

  it.each([2, 3])("rejects unsupported report schema %i", async (schemaVersion) => {
    const { parseComposedUpdateReport } = await loadReportModule();

    expect(() =>
      parseComposedUpdateReport({ ...legacyReport(), schemaVersion }, "0.0.0-pre-alpha.5.16"),
    ).toThrow();
  });

  it("requires the report contract owned by the exact incumbent", async () => {
    const { parseComposedUpdateReport } = await loadReportModule();

    expect(() => parseComposedUpdateReport(legacyReport(), "0.0.0-local")).toThrow(
      /Expected update report schema 5/u,
    );
    expect(() => parseComposedUpdateReport(currentReport(), "0.0.0-pre-alpha.5.16")).toThrow(
      /Expected update report schema 1/u,
    );
  });
});
