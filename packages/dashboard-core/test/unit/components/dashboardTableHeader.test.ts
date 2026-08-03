import { describe, expect, it } from "vitest";
import {
  dashboardPersistentFilterHeaderModel,
  dashboardTableHeaderModel,
} from "../../../src/components/Dashboard/tableHeader.js";
import { cellWidth, type RowGridLayout } from "../../../src/components/WorktreeRow/layout.js";
import type { DashboardPersistentFilterProjection } from "../../../src/selectors/dashboardPersistentFilter.js";

const HEADER_LAYOUT: RowGridLayout = {
  id: "header",
  segments: [],
  hidden: { cells: [], metadata: [] },
};
const NO_OVERFLOW = { above: 0, below: 0, visible: 4, total: 4 };

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

describe("dashboard table header model", () => {
  it("gives a persistent filter precedence in the shared header row", () => {
    const model = dashboardTableHeaderModel({
      layout: HEADER_LAYOUT,
      overflow: { ...NO_OVERFLOW, above: 2 },
      persistentFilter: projection(),
    });

    expect(model.kind).toBe("persistentFilter");
  });

  it("gives above overflow precedence over the available column layout", () => {
    const overflow = { ...NO_OVERFLOW, above: 2, total: 6 };

    expect(dashboardTableHeaderModel({ layout: HEADER_LAYOUT, overflow })).toEqual({
      kind: "aboveOverflow",
      overflow,
    });
  });

  it("uses column headers when the viewport is at the top", () => {
    expect(dashboardTableHeaderModel({ layout: HEADER_LAYOUT, overflow: NO_OVERFLOW })).toEqual({
      kind: "columns",
      layout: HEADER_LAYOUT,
    });
  });

  it("uses one empty header row when no layout exists", () => {
    expect(dashboardTableHeaderModel({ layout: undefined, overflow: NO_OVERFLOW })).toEqual({
      kind: "empty",
    });
  });
});

describe("dashboard persistent filter header", () => {
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
    expect(lineText(model).startsWith(" ")).toBe(true);
    expect(lineText(model).endsWith(" ")).toBe(true);
    expect(cellWidth(lineText(model))).toBeLessThanOrEqual(40);
    expect(lineText(model)).not.toContain("\n");
  });

  it("includes above-viewport context, counts, and a zero-match cue", () => {
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
    expect(lineText(model).startsWith(" ")).toBe(true);
    expect(lineText(model).endsWith(" ")).toBe(true);
    expect(cellWidth(lineText(model))).toBeLessThanOrEqual(32);
  });
});
