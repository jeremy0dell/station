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
    projectLabel: "Web Console",
    visibleFields: {
      title: "Alpha alpha",
      agent: "Codex",
      status: "working",
    },
  },
  {
    kind: "optimistic",
    id: "create:beta",
    projectId: "api",
    projectLabel: "API",
    visibleFields: {
      title: "Pending Beta",
      agent: "Pi",
      status: "starting session...",
    },
  },
];

describe("dashboard persistent filter selector", () => {
  it("lets an editing draft override the applied query and returns every visible match range", () => {
    const projection = selectDashboardPersistentFilter({
      candidates,
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
        status: [],
        projectLabel: [],
      },
    });
    expect(projection?.rows.get("create:beta")?.dimmed).toBe(true);
  });

  it("matches visible agent, status, and project labels for session and optimistic rows", () => {
    const byAgent = selectDashboardPersistentFilter({
      candidates,
      screen: { name: "dashboard" },
      applied: { query: "pi" },
    });
    const byStatus = selectDashboardPersistentFilter({
      candidates,
      screen: { name: "dashboard" },
      applied: { query: "WORK" },
    });
    const byProject = selectDashboardPersistentFilter({
      candidates,
      screen: { name: "dashboard" },
      applied: { query: "console" },
    });

    expect(byAgent?.rows.get("create:beta")?.ranges.agent).toEqual([{ start: 0, end: 2 }]);
    expect(byStatus?.rows.get("session:alpha")?.ranges.status).toEqual([{ start: 0, end: 4 }]);
    expect(byProject?.rows.get("session:alpha")?.ranges.projectLabel).toEqual([
      { start: 4, end: 11 },
    ]);
    expect(byProject?.projects.get("web")?.labelRanges).toEqual([{ start: 4, end: 11 }]);
  });

  it("treats a blank editing query as a recoverable all-match preview", () => {
    const projection = selectDashboardPersistentFilter({
      candidates,
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
      screen: { name: "dashboard" },
      applied: { query: "missing" },
    });

    expect(projection).toMatchObject({ matchCount: 0, totalCount: 2, zeroMatches: true });
    expect([...(projection?.rows.keys() ?? [])]).toEqual(["session:alpha", "create:beta"]);
    expect([...(projection?.rows.values() ?? [])].every((match) => match.dimmed)).toBe(true);
  });

  it("returns no projection when neither a draft nor applied state exists", () => {
    expect(
      selectDashboardPersistentFilter({ candidates, screen: { name: "dashboard" } }),
    ).toBeUndefined();
  });
});
