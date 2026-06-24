import { describe, expect, it } from "bun:test";
import { createInitialTuiState } from "@station/dashboard-core";
import {
  attentionAndFailuresSnapshot,
  manyProjectsSnapshot,
} from "../station/fixtures/scenarios.js";
import { selectStationButtonStatus, stationButtonStatusEqual } from "./status.js";

describe("selectStationButtonStatus", () => {
  it("is empty before a snapshot arrives", () => {
    expect(selectStationButtonStatus(createInitialTuiState())).toEqual({
      attention: false,
      workingCount: 0,
      idleCount: 0,
    });
  });

  it("reports working/idle totals and no attention for a healthy snapshot", () => {
    const snapshot = manyProjectsSnapshot();
    const status = selectStationButtonStatus(createInitialTuiState({ initialSnapshot: snapshot }));

    expect(status.workingCount).toBe(snapshot.counts.working);
    expect(status.idleCount).toBe(snapshot.counts.idle);
    expect(status.attention).toBe(false);
    expect(status.sessionName).toBeUndefined();
    expect(status.attentionWorktreeId).toBeUndefined();
  });

  it("flags the first session needing the user", () => {
    const snapshot = attentionAndFailuresSnapshot();
    const status = selectStationButtonStatus(createInitialTuiState({ initialSnapshot: snapshot }));
    const firstFlagged = snapshot.rows.find(
      (row) =>
        row.display.statusLabel === "needs attention" || row.display.statusLabel === "stuck",
    );

    expect(status.attention).toBe(true);
    expect(status.attentionWorktreeId).toBe(firstFlagged?.id);
    expect(typeof status.sessionName).toBe("string");
  });

  it("alerts on a stuck session even though counts.attention excludes it", () => {
    const base = attentionAndFailuresSnapshot();
    const stuckRow = base.rows.find((row) => row.display.statusLabel === "stuck");
    if (stuckRow === undefined) {
      throw new Error("fixture is expected to contain a stuck row");
    }
    // A stuck-only snapshot: the observer's counts.attention is 0, but the
    // session still needs the user.
    const snapshot = { ...base, rows: [stuckRow], counts: { ...base.counts, attention: 0 } };
    const status = selectStationButtonStatus(createInitialTuiState({ initialSnapshot: snapshot }));

    expect(status.attention).toBe(true);
    expect(status.attentionWorktreeId).toBe(stuckRow.id);
  });

  it("compares field-wise so the snapshot reference can stay stable", () => {
    const snapshot = manyProjectsSnapshot();
    const a = selectStationButtonStatus(createInitialTuiState({ initialSnapshot: snapshot }));
    const b = selectStationButtonStatus(createInitialTuiState({ initialSnapshot: snapshot }));

    expect(stationButtonStatusEqual(a, b)).toBe(true);
    expect(stationButtonStatusEqual(a, { ...a, workingCount: a.workingCount + 1 })).toBe(false);
  });
});
