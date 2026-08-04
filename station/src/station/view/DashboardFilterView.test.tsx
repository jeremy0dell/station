import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import {
  dashboardPersistentFilterHeaderModel,
  dashboardPersistentFilterSummarySegments,
  type DashboardPersistentFilterProjection,
} from "@station/dashboard-core";
import { spanAtFrameCell } from "../../terminal/testing/frameProbe.js";
import {
  nativeStationTheme,
  stationColorSnapshotValue,
  StationThemeProvider,
} from "../../theme/index.js";
import { DashboardFilterView } from "./DashboardFilterView.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

function projection(
  overrides: Partial<DashboardPersistentFilterProjection> = {},
): DashboardPersistentFilterProjection {
  const query = overrides.query ?? "working";
  const conditions = overrides.conditions ?? [];
  return {
    source: "draft",
    query,
    conditions,
    summarySegments: dashboardPersistentFilterSummarySegments({ query, conditions }),
    active: true,
    draft: { value: "working", cursor: 7 },
    matchCount: 2,
    totalCount: 8,
    zeroMatches: false,
    rows: new Map(),
    projects: new Map(),
    ...overrides,
  };
}

async function renderFilter(
  input: Partial<DashboardPersistentFilterProjection> = {},
  width = 50,
) {
  const model = dashboardPersistentFilterHeaderModel({
    columns: width,
    projection: projection(input),
    overflow: { above: 0, below: 6, visible: 2, total: 8 },
  });
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <DashboardFilterView model={model} />
    </StationThemeProvider>,
    { width, height: 1 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  return setup;
}

function foregroundHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.fg === undefined ? undefined : rgbToHex(span.fg);
}

function backgroundHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.bg === undefined ? undefined : rgbToHex(span.bg);
}

describe("DashboardFilterView", () => {
  it("renders the editor label, slash, visible caret, and count", async () => {
    const setup = await renderFilter();
    const line = setup.captureCharFrame().split("\n")[0] ?? "";

    expect(line).toContain("FILTER /working▏");
    expect(line).toContain("2/8 matches");
    const caretColumn = line.lastIndexOf("▏");
    expect(caretColumn).toBeGreaterThan(0);
    expect(foregroundHex(spanAtFrameCell(setup.captureSpans(), 0, caretColumn))).toBe(
      stationColorSnapshotValue(nativeStationTheme.filter.editorRail),
    );
    expect(backgroundHex(spanAtFrameCell(setup.captureSpans(), 0, caretColumn))).toBe(
      stationColorSnapshotValue(nativeStationTheme.filter.editorSurface),
    );
  });

  it("renders a zero-match count with the amber semantic token", async () => {
    const setup = await renderFilter({ matchCount: 0, zeroMatches: true });
    const line = setup.captureCharFrame().split("\n")[0] ?? "";
    const countColumn = line.indexOf("0/8");

    expect(countColumn).toBeGreaterThan(0);
    expect(foregroundHex(spanAtFrameCell(setup.captureSpans(), 0, countColumn))).toBe(
      stationColorSnapshotValue(nativeStationTheme.filter.zeroMatch),
    );
  });

  it("renders an applied summary on the neutral applied surface", async () => {
    const setup = await renderFilter({
      source: "applied",
      draft: undefined,
      query: "working",
    });
    const line = setup.captureCharFrame().split("\n")[0] ?? "";

    expect(line).toContain("FILTER working");
    const queryColumn = line.indexOf("working");
    expect(backgroundHex(spanAtFrameCell(setup.captureSpans(), 0, queryColumn))).toBe(
      stationColorSnapshotValue(nativeStationTheme.filter.appliedSurface),
    );
  });

  it("syntax-colors Status, Project, and Agent values in the canonical summary", async () => {
    const setup = await renderFilter(
      {
        source: "applied",
        draft: undefined,
        query: "queue",
        conditions: [
          { field: "status", values: [{ id: "working", label: "Working" }] },
          { field: "project", values: [{ id: "api", label: "API" }] },
          { field: "agent", values: [{ id: "codex", label: "Codex" }] },
        ],
      },
      80,
    );
    const line = setup.captureCharFrame().split("\n")[0] ?? "";
    const spans = setup.captureSpans();

    expect(line).toContain("queue · Status=Working · Project=API · Agent=Codex");
    expect(foregroundHex(spanAtFrameCell(spans, 0, line.indexOf("Working")))).toBe(
      stationColorSnapshotValue(nativeStationTheme.status.working),
    );
    expect(foregroundHex(spanAtFrameCell(spans, 0, line.indexOf("API")))).toBe(
      stationColorSnapshotValue(nativeStationTheme.action.primary),
    );
    expect(foregroundHex(spanAtFrameCell(spans, 0, line.indexOf("Codex")))).toBe(
      stationColorSnapshotValue(nativeStationTheme.status.accent),
    );
  });

  it("keeps long Unicode drafts clipped to the provided width", async () => {
    const width = 24;
    const setup = await renderFilter(
      {
        query: "修正-long-dashboard-filter-query",
        draft: { value: "修正-long-dashboard-filter-query", cursor: 31 },
      },
      width,
    );
    const line = setup.captureCharFrame().split("\n")[0] ?? "";

    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThanOrEqual(width);
    expect(line).toContain("▏");
  });
});
