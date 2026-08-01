import {
  type DashboardOptimisticSearchProjection,
  type DashboardSessionSearchProjection,
  matchesDashboardOptimisticSearch,
  matchesDashboardSessionSearch,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

const sessionProjection: DashboardSessionSearchProjection = {
  displayTitle: "Readable Feature Task",
  branch: "station-e91f2b",
  projectLabel: "Web Console",
  statusValue: "needs_attention",
  statusReason: "Agent needs approval.",
  harnessProvider: "codex",
  terminalProvider: "tmux",
};

describe("dashboard session search projection", () => {
  it.each([
    ["resolved display title", "readable feature"],
    ["branch", "E91F2B"],
    ["project label", "web console"],
    ["status value", "needs_attention"],
    ["status reason", "NEEDS APPROVAL"],
    ["harness provider", "codex"],
    ["terminal provider", "tmux"],
  ])("matches by %s", (_field, query) => {
    expect(matchesDashboardSessionSearch(sessionProjection, query)).toBe(true);
  });

  it("folds case, trims queries, and rejects unrelated text", () => {
    expect(matchesDashboardSessionSearch(sessionProjection, "  ReAdAbLe  ")).toBe(true);
    expect(matchesDashboardSessionSearch(sessionProjection, "unrelated")).toBe(false);
  });

  it("matches every session when the normalized query is empty", () => {
    expect(matchesDashboardSessionSearch(sessionProjection, "   ")).toBe(true);
  });
});

describe("dashboard optimistic-row search projection", () => {
  const pendingProjection: DashboardOptimisticSearchProjection = {
    title: "Hexagonal PT 12",
    branch: "station-a81f4c",
    projectLabel: "Web Console",
    pendingHarnessProvider: "codex",
  };

  it.each([
    ["title", "HEXAGONAL"],
    ["hidden branch", "a81f4c"],
    ["project label", "web console"],
    ["pending harness", "CODEX"],
  ])("matches by %s", (_field, query) => {
    expect(matchesDashboardOptimisticSearch(pendingProjection, query)).toBe(true);
  });

  it("trims the query and excludes a harness once the row is no longer pending", () => {
    const failedProjection: DashboardOptimisticSearchProjection = {
      ...pendingProjection,
      pendingHarnessProvider: undefined,
    };

    expect(matchesDashboardOptimisticSearch(pendingProjection, "  HeXaGoNaL ")).toBe(true);
    expect(matchesDashboardOptimisticSearch(failedProjection, "codex")).toBe(false);
  });

  it("matches every optimistic row when the normalized query is empty", () => {
    expect(matchesDashboardOptimisticSearch(pendingProjection, "   ")).toBe(true);
  });
});
