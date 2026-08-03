import {
  type DashboardPersistentFilterCandidate,
  selectDashboardPersistentFilter,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

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
    hiddenFields: {
      branch: "feature/alpha",
      status: "needs_attention",
      reason: "Agent needs approval.",
      terminal: "tmux",
    },
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
      },
    });
    expect(projection?.rows.get("create:beta")?.dimmed).toBe(true);
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

  it("selects exactly one hidden-only explanation in branch, status, reason, terminal order", () => {
    const byBranch = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "feature" },
    });
    const byStatus = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "attention" },
    });
    const byReason = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "approval" },
    });
    const byTerminal = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "tmux" },
    });

    expect(byBranch?.rows.get("session:alpha")?.reason).toEqual({
      field: "branch",
      value: "feature/alpha",
      ranges: [{ start: 0, end: 7 }],
    });
    expect(byStatus?.rows.get("session:alpha")?.reason).toEqual({
      field: "status",
      value: "needs_attention",
      ranges: [{ start: 6, end: 15 }],
    });
    expect(byReason?.rows.get("session:alpha")?.reason).toEqual({
      field: "reason",
      value: "Agent needs approval.",
      ranges: [{ start: 12, end: 20 }],
    });
    expect(byTerminal?.rows.get("session:alpha")?.reason).toEqual({
      field: "terminal",
      value: "tmux",
      ranges: [{ start: 0, end: 4 }],
    });
  });

  it("does not explain a hidden-field match when a visible field also matches", () => {
    const projection = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "dashboard" },
      applied: { query: "alpha" },
    });

    expect(projection?.rows.get("session:alpha")?.reason).toBeUndefined();
  });

  it("maps expanded and non-ASCII folds back to source-string offsets", () => {
    const sourceCandidates: DashboardPersistentFilterCandidate[] = [
      {
        kind: "session",
        id: "session:unicode",
        projectId: "web",
        visibleFields: { title: "İx CAFÉ" },
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

  it("treats a blank editing query as a recoverable all-match preview", () => {
    const projection = selectDashboardPersistentFilter({
      candidates,
      projects,
      screen: { name: "persistentFilter", draft: { value: "   ", cursor: 3 } },
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
