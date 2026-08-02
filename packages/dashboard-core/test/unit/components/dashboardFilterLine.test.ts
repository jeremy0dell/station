import {
  cellWidth,
  type DashboardPersistentFilterProjection,
  dashboardPersistentFilterEditingFooterModel,
  dashboardPersistentFilterHeaderModel,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

function projection(
  overrides: Partial<DashboardPersistentFilterProjection> = {},
): DashboardPersistentFilterProjection {
  return {
    source: "draft",
    query: "alpha",
    draft: { value: "alpha", cursor: 5 },
    matchCount: 1,
    totalCount: 7,
    zeroMatches: false,
    rows: new Map(),
    projects: new Map(),
    ...overrides,
  };
}

function lineText(model: ReturnType<typeof dashboardPersistentFilterHeaderModel>): string {
  return model.segments.map((segment) => segment.text).join("");
}

describe("dashboard persistent filter line", () => {
  it("keeps a long editor draft on one line with a visible caret window", () => {
    const model = dashboardPersistentFilterHeaderModel({
      columns: 40,
      projection: projection({
        query: "long dashboard filter query",
        draft: { value: "long dashboard filter query", cursor: 24 },
      }),
      overflow: { above: 0, below: 3, visible: 4, total: 7 },
    });

    expect(model.kind).toBe("editing");
    expect(model.segments.some((segment) => segment.role === "caret" && segment.text === "▏")).toBe(
      true,
    );
    expect(lineText(model)).toContain("FILTER /");
    expect(cellWidth(lineText(model))).toBeLessThanOrEqual(40);
    expect(lineText(model)).not.toContain("\n");
  });

  it("includes above-viewport context, counts, and an amber-ready zero-match cue", () => {
    const model = dashboardPersistentFilterHeaderModel({
      columns: 60,
      projection: projection({ matchCount: 0, zeroMatches: true }),
      overflow: { above: 2, below: 1, visible: 4, total: 7 },
    });

    expect(model.zeroMatches).toBe(true);
    expect(lineText(model)).toContain("↑2 · 0/7 matches");
    expect(model.segments.find((segment) => segment.role === "count")?.text).toContain("0/7");
  });

  it("truncates an applied summary without wrapping while preserving the count", () => {
    const model = dashboardPersistentFilterHeaderModel({
      columns: 32,
      projection: projection({
        source: "applied",
        query: "a very long applied dashboard filter summary",
        draft: undefined,
        matchCount: 3,
      }),
      overflow: { above: 0, below: 4, visible: 3, total: 7 },
    });

    expect(model.kind).toBe("applied");
    expect(lineText(model)).toContain("FILTER ");
    expect(lineText(model)).toContain("3/7 matches");
    expect(lineText(model)).toContain("…");
    expect(cellWidth(lineText(model))).toBeLessThanOrEqual(32);
  });

  it("selects bounded full and compact FILTER helper models", () => {
    const full = dashboardPersistentFilterEditingFooterModel(80);
    const compact = dashboardPersistentFilterEditingFooterModel(32);
    const fullText = full.segments.map((segment) => segment.text).join("");
    const compactText = compact.segments.map((segment) => segment.text).join("");

    expect(fullText).toContain("FILTER");
    expect(fullText).toContain("←→ cursor");
    expect(fullText).toContain("Ctrl-U clear");
    expect(compactText).toContain("↵ apply");
    expect(cellWidth(compactText)).toBeLessThanOrEqual(32);
  });
});
