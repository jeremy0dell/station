import { describe, expect, it } from "vitest";
import {
  helpPanelBodyRows,
  helpPanelLines,
} from "../../../src/components/HelpOverlay/helpPanel.js";
import { verticalScrollbarCells } from "../../../src/components/scrollbar.js";
import { dashboardRowIds, selectDashboardTree } from "../../../src/selectors/dashboardTree.js";
import { selectDashboardViewport } from "../../../src/selectors/dashboardViewport.js";
import { focusDashboardSession } from "../../../src/state/dashboardFocus.js";
import {
  clampDashboardStateScroll,
  scrollDashboard,
  scrollDashboardTo,
} from "../../../src/state/dashboardScroll.js";
import type { TuiHelpContentLine } from "../../../src/state/keymap.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { handleTuiKey } from "../../../src/state/transition.js";
import {
  createCrowdedDashboardSnapshot,
  createCrowdedGroupedDashboardSnapshot,
} from "../../fixtures/snapshots.js";

const TERMINAL_ROWS = 24;
const SESSION_COUNT = 300;

describe("dashboard windowing stress", () => {
  it("every offset shows tree[offset], including when the thumb would not move", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const tree = selectDashboardTree(snapshot, initial, initial.screen);
    const start = selectDashboardViewport(snapshot, initial);
    const maxOffset = tree.visibleRows.length - start.bodyRows;
    expect(maxOffset).toBeGreaterThan(SESSION_COUNT - start.bodyRows);

    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const state = scrollDashboardTo(initial, offset);
      const viewport = selectDashboardViewport(snapshot, state);
      expect(state.scrollOffset).toBe(offset);
      expect(viewport.clampedScrollOffset).toBe(offset);
      expect(viewport.hiddenAbove).toBe(offset);
      expect(viewport.hiddenBelow).toBe(maxOffset - offset);
      expect(viewport.rows[0]?.id).toBe(tree.visibleRows[offset]?.id);
      expect(viewport.rows.at(-1)?.id).toBe(
        tree.visibleRows[offset + viewport.rows.length - 1]?.id,
      );
    }
  });

  it("wheels one tree row at a time down to the last window and refuses to overshoot", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    let state = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const maxOffset = maxScrollOffset(snapshot, state);

    for (let step = 0; step < maxOffset; step += 1) {
      const next = handleTuiKey(state, { input: "", mouseScroll: "down" }).state;
      expect(next.scrollOffset).toBe(state.scrollOffset + 1);
      state = next;
    }

    expect(handleTuiKey(state, { input: "", mouseScroll: "down" }).state).toBe(state);
    expect(selectDashboardViewport(snapshot, state).hiddenBelow).toBe(0);
  });

  it("wheels one tree row at a time up from the last window", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const maxOffset = maxScrollOffset(snapshot, initial);
    let state = scrollDashboardTo(initial, maxOffset);
    const lastId = firstRowId(selectDashboardViewport(snapshot, state));

    const next = handleTuiKey(state, { input: "", mouseScroll: "up" }).state;
    expect(next.scrollOffset).toBe(maxOffset - 1);
    expect(firstRowId(selectDashboardViewport(snapshot, next))).not.toBe(lastId);

    state = scrollDashboardTo(initial, 0);
    expect(handleTuiKey(state, { input: "", mouseScroll: "up" }).state).toBe(state);
  });

  it("arrow-down never skips more tree rows than the cursor moved, and reaches the last window", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    let state = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);
    const maxOffset = maxScrollOffset(snapshot, state);
    const budget = tree.visibleRows.length + 8;

    for (let step = 0; step < budget; step += 1) {
      const previous = state;
      const previousIndex = focusedIndex(tree, previous);
      state = handleTuiKey(state, { input: "", downArrow: true }).state;
      const nextIndex = focusedIndex(tree, state);
      expect(state.scrollOffset).toBeGreaterThanOrEqual(previous.scrollOffset);
      expect(state.scrollOffset - previous.scrollOffset).toBeLessThanOrEqual(
        Math.max(1, nextIndex - previousIndex),
      );
      if (state.scrollOffset === maxOffset && nextIndex === previousIndex) {
        break;
      }
    }

    expect(state.scrollOffset).toBe(maxOffset);
    expect(selectDashboardViewport(snapshot, state).hiddenBelow).toBe(0);
  });

  it("scrollTo(max) and a past-the-end offset both land on the last window", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const maxOffset = maxScrollOffset(snapshot, state);
    const atMax = scrollDashboardTo(state, maxOffset);
    const pastEnd = scrollDashboardTo(atMax, maxOffset + 50);
    expect(atMax.scrollOffset).toBe(maxOffset);
    expect(pastEnd).toBe(atMax);
    expect(selectDashboardViewport(snapshot, atMax).hiddenBelow).toBe(0);
  });

  it("pages by 5 near the end clamp to max instead of overshooting", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const maxOffset = maxScrollOffset(snapshot, state);
    expect(scrollDashboard(scrollDashboardTo(state, maxOffset - 2), 5).scrollOffset).toBe(
      maxOffset,
    );
    expect(scrollDashboard(state, -5).scrollOffset).toBe(0);
  });

  it("widening the terminal while pinned at the bottom keeps the last window, not a hole", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    const compact = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const maxOffset = maxScrollOffset(snapshot, compact);
    const pinned = scrollDashboardTo(compact, maxOffset);
    const widened = clampDashboardStateScroll({ ...pinned, terminalRows: 40 });
    const viewport = selectDashboardViewport(snapshot, widened);
    expect(widened.scrollOffset).toBeLessThan(maxOffset);
    expect(viewport.hiddenBelow).toBe(0);
    expect(viewport.rows.at(-1)?.id).toBe(
      selectDashboardTree(snapshot, widened, widened.screen).visibleRows.at(-1)?.id,
    );
  });

  it("shrinking the terminal while at the tall bottom keeps a valid offset that is no longer the last window", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    const tall = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: 40,
    });
    const pinned = scrollDashboardTo(tall, maxScrollOffset(snapshot, tall));
    const shrunk = clampDashboardStateScroll({ ...pinned, terminalRows: TERMINAL_ROWS });
    expect(shrunk.scrollOffset).toBe(pinned.scrollOffset);
    expect(selectDashboardViewport(snapshot, shrunk).hiddenBelow).toBeGreaterThan(0);
  });

  it("arrow-down walks the cursor through the first window before the offset moves", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    let state = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const bodyRows = selectDashboardViewport(snapshot, state).bodyRows;
    const entered = handleTuiKey(state, { input: "", downArrow: true }).state;
    expect(entered.scrollOffset).toBe(0);
    expect(entered.dashboardFocus).toBeDefined();
    state = entered;
    let downs = 1;
    while (state.scrollOffset === 0 && downs < bodyRows + 8) {
      state = handleTuiKey(state, { input: "", downArrow: true }).state;
      downs += 1;
    }
    expect(downs).toBeGreaterThan(2);
    expect(state.scrollOffset).toBe(1);
  });

  it("a one-row wheel still changes the window when the painted thumb does not", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const tree = selectDashboardTree(snapshot, initial, initial.screen);
    const viewportLength = selectDashboardViewport(snapshot, initial).bodyRows;
    const paint = {
      trackHeight: viewportLength,
      contentLength: tree.visibleRows.length,
      viewportLength,
    };
    expect(verticalScrollbarCells({ ...paint, offset: 0 }).join("")).toBe(
      verticalScrollbarCells({ ...paint, offset: 1 }).join(""),
    );
    const after = handleTuiKey(initial, { input: "", mouseScroll: "down" }).state;
    expect(after.scrollOffset).toBe(1);
    expect(firstRowId(selectDashboardViewport(snapshot, after))).not.toBe(
      firstRowId(selectDashboardViewport(snapshot, initial)),
    );
  });

  it("arrow-up from the last window focuses a visible row before the offset moves", () => {
    const snapshot = createCrowdedDashboardSnapshot(SESSION_COUNT);
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const maxOffset = maxScrollOffset(snapshot, initial);
    const pinned = scrollDashboardTo(initial, maxOffset);
    const entered = handleTuiKey(pinned, { input: "", upArrow: true }).state;
    expect(entered.scrollOffset).toBe(maxOffset);
    expect(entered.dashboardFocus).toBeDefined();
    let state = entered;
    let ups = 1;
    while (state.scrollOffset === maxOffset && ups < 40) {
      state = handleTuiKey(state, { input: "", upArrow: true }).state;
      ups += 1;
    }
    expect(ups).toBeGreaterThan(2);
    expect(state.scrollOffset).toBe(maxOffset - 1);
  });

  it("collapsing a crowded group while pinned at the bottom keeps a valid last window", () => {
    const snapshot = createCrowdedGroupedDashboardSnapshot(80);
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const maxBefore = maxScrollOffset(snapshot, initial);
    const pinned = scrollDashboardTo(initial, maxBefore);
    const collapsed = clampDashboardStateScroll({
      ...pinned,
      collapsedGroupIds: new Set(["group_crowd"]),
    });
    const viewport = selectDashboardViewport(snapshot, collapsed);
    expect(maxBefore).toBeGreaterThan(0);
    expect(collapsed.scrollOffset).toBeLessThan(maxBefore);
    expect(viewport.hiddenBelow).toBe(0);
    expect(collapsed.scrollOffset).toBeGreaterThanOrEqual(0);
  });

  it("wheels one tree row through inert group chrome that arrows skip", () => {
    const snapshot = createCrowdedGroupedDashboardSnapshot(40);
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: TERMINAL_ROWS,
    });
    const lastSessionId = snapshot.sessions
      .filter((session) => session.projectId === "web")
      .at(-1)?.id;
    if (lastSessionId === undefined) {
      throw new Error("expected a crowded web session");
    }
    const focused = focusDashboardSession(initial, lastSessionId);
    expect(focused.dashboardFocus?.rowId).toBe(dashboardRowIds.session(lastSessionId));
    const wheeled = handleTuiKey(focused, { input: "", mouseScroll: "down" }).state;
    const arrowed = handleTuiKey(focused, { input: "", downArrow: true }).state;
    expect(wheeled.scrollOffset).toBe(focused.scrollOffset + 1);
    expect(wheeled.dashboardFocus).toEqual(focused.dashboardFocus);
    expect(arrowed.dashboardFocus?.rowId).not.toBe(focused.dashboardFocus?.rowId);
    expect(arrowed.scrollOffset - focused.scrollOffset).toBeGreaterThan(1);
  });
});

describe("help windowing stress", () => {
  it("arrows one line at a time through a 300-line panel, including stuck-thumb offsets", () => {
    const content = crowdedHelpContent(300);
    const bodyRows = helpPanelBodyRows(TERMINAL_ROWS, content.length);
    const maxOffset = content.length - bodyRows;
    const height = bodyRows + 2;

    let state = createInitialTuiState({ terminalRows: TERMINAL_ROWS });
    state = { ...state, screen: { name: "help", scrollOffset: 0, contentLength: content.length } };

    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const lines = helpPanelLines(64, height, content, offset);
      expect(lines[1]).toContain(`line-${offset}`);
      expect(lines[bodyRows]).toContain(`line-${offset + bodyRows - 1}`);
    }

    for (let step = 0; step < maxOffset; step += 1) {
      const next = handleTuiKey(state, { input: "", downArrow: true }).state;
      expect(next.screen).toMatchObject({ name: "help", scrollOffset: step + 1 });
      state = next;
    }
    expect(handleTuiKey(state, { input: "", downArrow: true }).state).toBe(state);

    const up = handleTuiKey(state, { input: "", upArrow: true }).state;
    expect(up.screen).toMatchObject({ name: "help", scrollOffset: maxOffset - 1 });
    expect(handleTuiKey(up, { input: "", escape: true }).state.screen).toEqual({
      name: "dashboard",
    });
  });

  it("a one-line help wheel still changes the window when the painted thumb does not", () => {
    const content = crowdedHelpContent(300);
    const bodyRows = helpPanelBodyRows(TERMINAL_ROWS, content.length);
    const paint = {
      trackHeight: bodyRows,
      contentLength: content.length,
      viewportLength: bodyRows,
    };
    expect(verticalScrollbarCells({ ...paint, offset: 0 }).join("")).toBe(
      verticalScrollbarCells({ ...paint, offset: 1 }).join(""),
    );
    let state = createInitialTuiState({ terminalRows: TERMINAL_ROWS });
    state = {
      ...state,
      screen: { name: "help", scrollOffset: 0, contentLength: content.length },
      scrollOffset: 12,
    };
    const next = handleTuiKey(state, { input: "", mouseScroll: "down" }).state;
    expect(next.scrollOffset).toBe(12);
    expect(next.screen).toMatchObject({ name: "help", scrollOffset: 1 });
  });
});

function maxScrollOffset(
  snapshot: ReturnType<typeof createCrowdedDashboardSnapshot>,
  state: ReturnType<typeof createInitialTuiState>,
): number {
  const viewport = selectDashboardViewport(snapshot, state);
  return viewport.hiddenAbove + viewport.hiddenBelow;
}

function firstRowId(viewport: ReturnType<typeof selectDashboardViewport>): string {
  const id = viewport.rows[0]?.id;
  if (id === undefined) {
    throw new Error("expected a visible dashboard row");
  }
  return id;
}

function focusedIndex(
  tree: ReturnType<typeof selectDashboardTree>,
  state: ReturnType<typeof createInitialTuiState>,
): number {
  if (state.dashboardFocus === undefined) {
    return 0;
  }
  return tree.visibleIndexById.get(state.dashboardFocus.rowId) ?? 0;
}

function crowdedHelpContent(lineCount: number): TuiHelpContentLine[] {
  return Array.from({ length: lineCount }, (_, index) => ({
    key: String(index),
    description: `line-${index}`,
  }));
}
