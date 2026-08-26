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
    schemaVersion: 4,
    kind: "result",
    channel: "installer-binary",
    status: "updated",
    current: { version: "0.0.0-local" },
    target: { version: "0.0.1-local" },
    steps: [],
    warnings: [],
    recoveryCommands: [],
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
      /Expected update report schema 4/u,
    );
    expect(() => parseComposedUpdateReport(currentReport(), "0.0.0-pre-alpha.5.16")).toThrow(
      /Expected update report schema 1/u,
    );
  });
});
