import type { StationClientConnectionState } from "@station/client";
import type { SafeError, StationSnapshot } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { dashboardRowIds } from "../../src/selectors/dashboardTree.js";
import { createInitialTuiState } from "../../src/state/screen.js";
import { applySnapshotSourceState } from "../../src/state/sourceBridge.js";
import type { DashboardState } from "../../src/state/types.js";
import { createDashboardSnapshot, createZeroWorktreeSnapshot } from "../fixtures/snapshots.js";

const NOW = 1_750_000_000_000;

const lastError: SafeError = {
  tag: "ProtocolError",
  code: "PROTOCOL_CONNECT_FAILED",
  message: "Could not connect to the observer socket.",
};

describe("applySnapshotSourceState", () => {
  it("returns the same state when a no-snapshot failure update is content-identical", () => {
    const initial = createInitialTuiState();
    const connection: StationClientConnectionState = {
      state: "reconnecting",
      since: NOW - 500,
      lastError,
    };

    const first = applySnapshotSourceState(initial, { connection }, NOW);
    expect(first.observerConnectionStatus.state).toBe("reconnecting");

    const second = applySnapshotSourceState(first, { connection }, NOW + 50);
    expect(second).toBe(first);
  });

  it("returns the same state when a display-only update is content-identical", () => {
    // Only identity matters on this path; the snapshot's fields are never read.
    const snapshot = {} as StationSnapshot;
    const initial: DashboardState = { ...createInitialTuiState(), snapshot };
    const connection: StationClientConnectionState = {
      state: "displayOnly",
      since: NOW - 500,
      lastError,
    };

    const first = applySnapshotSourceState(initial, { snapshot, connection }, NOW);
    expect(first.observerConnectionStatus.state).toBe("displayOnly");
    expect(first.loading).toBe(false);

    const second = applySnapshotSourceState(first, { snapshot, connection }, NOW + 50);
    expect(second).toBe(first);
  });

  it("reconciles dashboard focus when a source snapshot replaces the list", () => {
    const snapshot = createDashboardSnapshot();
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.project("web"),
        cellId: "menu",
      },
    });
    const withoutWeb = {
      ...snapshot,
      projects: snapshot.projects.filter((project) => project.id !== "web"),
      rows: snapshot.rows.filter((row) => row.projectId !== "web"),
      sessions: snapshot.sessions.filter((session) => session.projectId !== "web"),
    };

    const replaced = applySnapshotSourceState(
      initial,
      {
        snapshot: withoutWeb,
        connection: { state: "connected", since: NOW },
      },
      NOW,
    );

    expect(replaced.dashboardFocus).toEqual({
      rowId: dashboardRowIds.project("api"),
      cellId: "identity",
    });
  });

  it.each([
    "projectMenu",
    "createGroup",
  ] as const)("closes a %s surface when its Project disappears", (screenName) => {
    const snapshot = createDashboardSnapshot();
    const screen =
      screenName === "projectMenu"
        ? ({ name: "projectMenu", projectId: "web", focus: "quickGroup" } as const)
        : ({
            name: "createGroup",
            projectId: "web",
            draftName: { value: "Draft", cursor: 5 },
            quickSession: false,
            focus: "name",
            submitting: true,
            returnTo: "projectMenu",
          } as const);
    const initial = {
      ...createInitialTuiState({
        initialSnapshot: snapshot,
        dashboardFocus: { rowId: dashboardRowIds.project("web"), cellId: "menu" },
      }),
      screen,
    };
    const withoutWeb = {
      ...snapshot,
      projects: snapshot.projects.filter((project) => project.id !== "web"),
      rows: snapshot.rows.filter((row) => row.projectId !== "web"),
      sessions: snapshot.sessions.filter((session) => session.projectId !== "web"),
    };

    const replaced = applySnapshotSourceState(
      initial,
      { snapshot: withoutWeb, connection: { state: "connected", since: NOW } },
      NOW,
    );

    expect(replaced.screen).toEqual({ name: "dashboard" });
    expect(replaced.dashboardFocus).toEqual({
      rowId: dashboardRowIds.project("api"),
      cellId: "identity",
    });
  });

  it("preserves or positionally reconciles empty-project focus across source snapshots", () => {
    const snapshot = createZeroWorktreeSnapshot();
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: { rowId: dashboardRowIds.empty("web"), cellId: "addSession" },
    });
    const connected = { state: "connected" as const, since: NOW };

    const preserved = applySnapshotSourceState(
      initial,
      { snapshot: { ...snapshot, generatedAt: "2026-05-20T12:01:00.000Z" }, connection: connected },
      NOW,
    );
    expect(preserved.dashboardFocus).toEqual({
      rowId: dashboardRowIds.empty("web"),
      cellId: "addSession",
    });

    const reconciled = applySnapshotSourceState(
      initial,
      { snapshot: createDashboardSnapshot(), connection: connected },
      NOW,
    );
    expect(reconciled.dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_working"),
      cellId: "identity",
    });
  });

  it("still produces a new state when the failure status actually changes", () => {
    const initial = createInitialTuiState();
    const first = applySnapshotSourceState(
      initial,
      { connection: { state: "reconnecting", since: NOW - 500, lastError } },
      NOW,
    );

    const second = applySnapshotSourceState(
      first,
      { connection: { state: "reconnecting", since: NOW - 100, lastError } },
      NOW + 50,
    );

    expect(second).not.toBe(first);
    expect(second.observerConnectionStatus).toMatchObject({ since: NOW - 100 });
  });
});
