import { describe, expect, it } from "vitest";
import type { DashboardPersistentFilterCandidate } from "../../../src/selectors/dashboardPersistentFilter.js";
import { selectDashboardPersistentFilter } from "../../../src/selectors/dashboardPersistentFilter.js";

const candidates: DashboardPersistentFilterCandidate[] = [
  {
    kind: "session",
    id: "session:alpha",
    projectId: "web",
    visibleFields: {
      title: "Alpha alpha",
      agent: "Codex",
      activity: "working",
    },
    conditionValues: { status: "working", agent: "codex" },
  },
  {
    kind: "optimistic",
    id: "create:beta",
    projectId: "api",
    visibleFields: {
      title: "Pending Beta",
      agent: "Pi",
      activity: "starting session...",
    },
    conditionValues: { status: "starting", agent: "pi" },
  },
];

const projects = [
  { projectId: "web", projectLabel: "Web Console" },
  { projectId: "api", projectLabel: "API" },
  { projectId: "empty", projectLabel: "Empty Project" },
];

describe("dashboard persistent filter selector", () => {
  it("lets an editing draft override the applied query and returns every visible match range", () => {
    const projection = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: {
        name: "persistentFilter",
        draft: { value: "  ALPHA  ", cursor: 9 },
        draftConditions: [],
      },
      applied: { query: "beta" },
    });

    expect(projection).toMatchObject({
      source: "draft",
      query: "ALPHA",
      matchCount: 1,
      totalCount: 2,
      zeroMatches: false,
    });
    expect(projection?.rows.get("session:alpha")).toEqual({
      matched: true,
      dimmed: false,
      ranges: {
        title: [
          { start: 0, end: 5 },
          { start: 6, end: 11 },
        ],
        agent: [],
        activity: [],
        projectLabel: [],
        groupLabel: [],
      },
    });
    expect(projection?.rows.get("create:beta")?.dimmed).toBe(true);
  });

  it("previews the active field selection before it is retained", () => {
    const projection = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: {
        name: "persistentFilter",
        draft: { value: "", cursor: 0 },
        draftConditions: [],
        conditionEditor: {
          stage: "values",
          field: "status",
          cursor: 2,
          options: [
            { id: "needs_attention", label: "Needs attention" },
            { id: "stuck", label: "Stuck" },
            { id: "working", label: "Working" },
          ],
          selectedIds: ["working"],
        },
      },
    });

    expect(projection).toMatchObject({
      source: "draft",
      conditions: [{ field: "status", values: [{ id: "working", label: "Working" }] }],
      matchCount: 1,
    });
    expect(projection?.rows.get("session:alpha")?.matched).toBe(true);
    expect(projection?.rows.get("create:beta")?.matched).toBe(false);
  });

  it("matches visible agent, status, and project labels for session and optimistic rows", () => {
    const byAgent = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "pi" },
    });
    const byStatus = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "WORK" },
    });
    const byProject = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "console" },
    });

    expect(byAgent?.rows.get("create:beta")?.ranges.agent).toEqual([{ start: 0, end: 2 }]);
    expect(byStatus?.rows.get("session:alpha")?.ranges.activity).toEqual([{ start: 0, end: 4 }]);
    expect(byProject?.rows.get("session:alpha")?.ranges.projectLabel).toEqual([
      { start: 4, end: 11 },
    ]);
    expect(byProject?.projects.get("web")?.labelRanges).toEqual([{ start: 4, end: 11 }]);
  });

  it("ORs values within a field and ANDs text with separate condition fields", () => {
    const byStatuses = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: {
        query: "",
        conditions: [
          {
            field: "status",
            values: [
              { id: "working", label: "Working" },
              { id: "starting", label: "Starting" },
            ],
          },
        ],
      },
    });
    const byProjectAndAgent = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: {
        query: "pending",
        conditions: [
          { field: "project", values: [{ id: "api", label: "API" }] },
          { field: "agent", values: [{ id: "pi", label: "Pi" }] },
        ],
      },
    });

    expect(byStatuses?.matchCount).toBe(2);
    expect(byProjectAndAgent?.matchCount).toBe(1);
    expect(byProjectAndAgent?.rows.get("session:alpha")?.matched).toBe(false);
    expect(byProjectAndAgent?.rows.get("create:beta")?.matched).toBe(true);
  });

  it("retains every row for a selected project when no row condition narrows it", () => {
    const projection = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: {
        query: "",
        conditions: [{ field: "project", values: [{ id: "web", label: "Web Console" }] }],
      },
    });

    expect(projection?.rows.get("session:alpha")?.matched).toBe(true);
    expect(projection?.rows.get("create:beta")?.matched).toBe(false);
    expect(projection?.projects.get("web")?.matched).toBe(true);
    expect(projection?.projects.get("api")?.matched).toBe(false);
  });

  it("matches only the visible row and project fields supplied by the viewport", () => {
    const projection = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "feature" },
    });

    expect(projection).toMatchObject({ matchCount: 0, totalCount: 2, zeroMatches: true });
    expect(projection?.rows.get("session:alpha")).toMatchObject({
      matched: false,
      dimmed: true,
    });
  });

  it("maps expanded and non-ASCII folds back to source-string offsets", () => {
    const sourceCandidates: DashboardPersistentFilterCandidate[] = [
      {
        kind: "session",
        id: "session:unicode",
        projectId: "web",
        visibleFields: { title: "İx CAFÉ" },
        conditionValues: {},
      },
    ];
    const byExpansion = selectDashboardPersistentFilter({
      candidates: sourceCandidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "X" },
    });
    const byAccent = selectDashboardPersistentFilter({
      candidates: sourceCandidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "é" },
    });

    expect(byExpansion?.rows.get("session:unicode")?.ranges.title).toEqual([{ start: 1, end: 2 }]);
    expect(byAccent?.rows.get("session:unicode")?.ranges.title).toEqual([{ start: 6, end: 7 }]);
  });

  it("seeds match metadata for project headers without row candidates", () => {
    const byLabel = selectDashboardPersistentFilter({
      candidates: [],
      projects,
      screen: { name: "dashboard" },
      applied: { query: "empty" },
    });
    const unmatched = selectDashboardPersistentFilter({
      candidates: [],
      projects,
      screen: { name: "dashboard" },
      applied: { query: "missing" },
    });

    expect(byLabel?.projects.get("empty")).toEqual({
      matched: true,
      labelRanges: [{ start: 0, end: 5 }],
    });
    expect(unmatched?.projects.get("empty")).toEqual({ matched: false, labelRanges: [] });
  });

  it("uses Group names as member context and member matches as retained Group context", () => {
    const sessionCandidate = candidates[0];
    if (sessionCandidate === undefined) throw new Error("expected session candidate");
    const groupedCandidates: DashboardPersistentFilterCandidate[] = [
      { ...sessionCandidate, groupId: "group_active" },
    ];
    const groups = [
      { groupId: "group_active", projectId: "web", groupLabel: "Active work" },
      { groupId: "group_empty", projectId: "web", groupLabel: "Empty" },
    ];
    const byGroup = selectDashboardPersistentFilter({
      candidates: groupedCandidates,
      projects,
      groups,
      screen: { name: "dashboard" },
      applied: { query: "active" },
    });
    const byMember = selectDashboardPersistentFilter({
      candidates: groupedCandidates,
      projects,
      groups,
      screen: { name: "dashboard" },
      applied: { query: "alpha" },
    });

    expect(byGroup?.rows.get("session:alpha")?.ranges.groupLabel).toEqual([{ start: 0, end: 6 }]);
    expect(byGroup?.groups.get("group_active")).toEqual({
      matched: true,
      labelRanges: [{ start: 0, end: 6 }],
    });
    expect(byMember?.groups.get("group_active")?.matched).toBe(true);
    expect(byMember?.groups.get("group_empty")?.matched).toBe(false);
    expect(byMember?.projects.get("web")?.matched).toBe(true);
  });

  it("treats a blank editing query as a recoverable all-match preview", () => {
    const projection = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: {
        name: "persistentFilter",
        draft: { value: "   ", cursor: 3 },
        draftConditions: [],
      },
    });

    expect(projection).toMatchObject({
      source: "draft",
      query: "",
      matchCount: 2,
      totalCount: 2,
      zeroMatches: false,
    });
    expect([...(projection?.rows.values() ?? [])].every((match) => !match.dimmed)).toBe(true);
  });

  it("reports zero matches without removing or reordering candidates", () => {
    const projection = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "missing" },
    });

    expect(projection).toMatchObject({ matchCount: 0, totalCount: 2, zeroMatches: true });
    expect([...(projection?.rows.keys() ?? [])]).toEqual(["session:alpha", "create:beta"]);
    expect([...(projection?.rows.values() ?? [])].every((match) => match.dimmed)).toBe(true);
  });

  it("returns no projection when neither a draft nor applied state exists", () => {
    expect(
      selectDashboardPersistentFilter({ candidates, projects, screen: { name: "dashboard" } }),
    ).toBeUndefined();
  });
});
