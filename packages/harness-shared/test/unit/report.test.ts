import { HarnessEventReportSchema, STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  buildHarnessEventReport,
  stationIdentityCorrelation,
  stationIdentityProviderData,
} from "../../src/report";

const now = "2026-05-27T12:00:00.000Z";

const identity = {
  station_project_id: "web",
  station_worktree_id: "wt_web",
  station_worktree_path: "/work/project",
  station_worktree_managed_root: "/work",
  station_session_id: "ses_web",
  station_terminal_provider: "tmux",
  station_terminal_target_id: "tt_web",
};

describe("buildHarnessEventReport", () => {
  it("assembles the base fields and leaves absent optionals off the report", () => {
    const report = buildHarnessEventReport(
      { reportId: "report_1", observedAt: now },
      { provider: "claude", eventType: "Stop" },
    );

    expect(HarnessEventReportSchema.parse(report)).toEqual(report);
    expect(report).toEqual({
      schemaVersion: STATION_SCHEMA_VERSION,
      reportId: "report_1",
      provider: "claude",
      kind: "harness",
      eventType: "Stop",
      observedAt: now,
      diagnostics: { rawEventType: "Stop" },
    });
    expect(report).not.toHaveProperty("status");
    expect(report).not.toHaveProperty("correlation");
    expect(report).not.toHaveProperty("coalesceKey");
    expect(report).not.toHaveProperty("providerData");
  });

  it("derives diagnostics from the input counters unless the caller supplies them", () => {
    const derived = buildHarnessEventReport(
      { reportId: "report_2", observedAt: now, diagnostics: { compacted: true, truncated: false } },
      { provider: "claude", eventType: "Stop" },
    );
    expect(derived.diagnostics).toMatchObject({ rawEventType: "Stop", compacted: true });

    const annotated = buildHarnessEventReport(
      { reportId: "report_3", observedAt: now, diagnostics: { compacted: true } },
      {
        provider: "codex",
        eventType: "SessionStart",
        diagnostics: {
          rawEventType: "SessionStart",
          correlationIssue: "station_identity_cwd_mismatch",
        },
      },
    );
    expect(annotated.diagnostics).toEqual({
      rawEventType: "SessionStart",
      correlationIssue: "station_identity_cwd_mismatch",
    });
  });
});

describe("stationIdentityProviderData", () => {
  it("emits camelCase keys in a fixed order", () => {
    expect(Object.keys(stationIdentityProviderData(identity))).toEqual([
      "stationProjectId",
      "stationWorktreeId",
      "stationWorktreePath",
      "stationWorktreeManagedRoot",
      "stationSessionId",
      "stationTerminalProvider",
      "stationTerminalTargetId",
    ]);
  });

  it("omits absent fields rather than emitting undefined values", () => {
    const data = stationIdentityProviderData({ station_project_id: "web" });

    expect(data).toEqual({ stationProjectId: "web" });
    expect(Object.keys(data)).toEqual(["stationProjectId"]);
  });
});

describe("stationIdentityCorrelation", () => {
  it("derives a pane-stable harnessRunId from the terminal target", () => {
    expect(stationIdentityCorrelation("claude", identity)).toEqual({
      projectId: "web",
      worktreeId: "wt_web",
      sessionId: "ses_web",
      terminalTargetId: "tt_web",
      harnessRunId: "claude:tt_web",
    });
  });

  it("mints no run id when the provider opts out or the terminal target is absent", () => {
    expect(
      stationIdentityCorrelation("codex", identity, { harnessRunId: false }),
    ).not.toHaveProperty("harnessRunId");
    expect(stationIdentityCorrelation("claude", { station_project_id: "web" })).not.toHaveProperty(
      "harnessRunId",
    );
  });
});
