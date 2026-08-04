import {
  createInitialTuiState,
  type DashboardFilterCondition,
  dashboardFilterConditionFieldForKey,
  dashboardFilterConditionFieldKey,
  dashboardFilterConditionFieldLabel,
  dashboardPersistentFilterSummarySegments,
  normalizeDashboardFilterConditions,
  selectDashboardFilterConditionOptions,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("dashboard filter conditions", () => {
  it("uses one field configuration for labels and shortcut keys", () => {
    expect(
      (["status", "project", "agent"] as const).map((field) => ({
        field,
        key: dashboardFilterConditionFieldKey(field),
        label: dashboardFilterConditionFieldLabel(field),
      })),
    ).toEqual([
      { field: "status", key: "S", label: "Status" },
      { field: "project", key: "P", label: "Project" },
      { field: "agent", key: "A", label: "Agent" },
    ]);
    expect(["s", "P", "a", "x"].map(dashboardFilterConditionFieldForKey)).toEqual([
      "status",
      "project",
      "agent",
      undefined,
    ]);
  });

  it("derives normalized status, project, and agent options with retained selections", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      localRows: {
        pendingCreate: [
          {
            localId: "local-cursor",
            projectId: "web",
            title: "Pending Cursor",
            branch: "pending-cursor",
            harnessProvider: "cursor",
            createdAt: "2026-08-03T00:00:00.000Z",
          },
        ],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [],
      },
    });
    const conditions: DashboardFilterCondition[] = [
      { field: "project", values: [{ id: "removed", label: "Removed project" }] },
      { field: "agent", values: [{ id: "pi", label: "Pi" }] },
    ];

    const options = selectDashboardFilterConditionOptions(snapshot, state, conditions);

    expect(options.status.map((option) => option.id)).toEqual([
      "needs_attention",
      "stuck",
      "working",
      "starting",
      "idle",
      "exited",
      "none",
      "unknown",
    ]);
    expect(options.project).toEqual([
      { id: "api", label: "api" },
      { id: "removed", label: "Removed project" },
      { id: "web", label: "web" },
    ]);
    expect(options.agent).toEqual([
      { id: "codex", label: "codex" },
      { id: "cursor", label: "cursor" },
      { id: "opencode", label: "opencode" },
      { id: "pi", label: "Pi" },
    ]);
  });

  it("deduplicates values and orders fields and statuses canonically", () => {
    expect(
      normalizeDashboardFilterConditions([
        { field: "agent", values: [{ id: "pi", label: "Pi" }] },
        {
          field: "status",
          values: [
            { id: "starting", label: "Starting" },
            { id: "working", label: "Working" },
            { id: "working", label: "duplicate" },
          ],
        },
        { field: "project", values: [] },
      ]),
    ).toEqual([
      {
        field: "status",
        values: [
          { id: "working", label: "Working" },
          { id: "starting", label: "Starting" },
        ],
      },
      { field: "agent", values: [{ id: "pi", label: "Pi" }] },
    ]);
  });

  it("builds one canonical free-text, Status, Project, Agent summary", () => {
    const segments = dashboardPersistentFilterSummarySegments({
      query: "queue",
      conditions: [
        { field: "agent", values: [{ id: "codex", label: "Codex" }] },
        { field: "project", values: [{ id: "api", label: "API" }] },
        {
          field: "status",
          values: [
            { id: "working", label: "Working" },
            { id: "starting", label: "Starting" },
          ],
        },
      ],
    });

    expect(segments.map((segment) => segment.text).join("")).toBe(
      "queue · Status=Working|Starting · Project=API · Agent=Codex",
    );
    expect(segments.filter((segment) => segment.role === "value")).toMatchObject([
      { field: "status", valueId: "working" },
      { field: "status", valueId: "starting" },
      { field: "project", valueId: "api" },
      { field: "agent", valueId: "codex" },
    ]);
  });
});
