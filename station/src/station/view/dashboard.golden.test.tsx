// Golden frames cover structural output; normalize the independently timed
// throbber so renderer speed cannot change an otherwise identical snapshot.
import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex, TextAttributes, type BaseRenderable } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { StationClientConnectionState } from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import type {
  ClientNotice,
  DashboardCapabilities,
  DashboardRuntimeOptions,
} from "@station/dashboard-core/runtime";
import { dashboardRowIds } from "@station/dashboard-core/selectors";
import { cellWidth } from "@station/dashboard-core/text";
import { act } from "react";
import { spanAtFrameCell } from "../../terminal/testing/frameProbe.js";
import {
  attentionAndFailuresSnapshot,
  externalAgentSnapshot,
  groupedManyProjectsSnapshot,
  manyProjectsSnapshot,
  noProjectsSnapshot,
} from "../fixtures/scenarios.js";
import { makeStationTestRuntime } from "../test/support/makeStationTestRuntime.js";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { DashboardRoot } from "./DashboardRoot.js";
import {
  nativeStationTheme,
  stationColorSnapshotValue,
  StationThemeProvider,
  type StationTheme,
} from "../../theme/index.js";
import { parseStationTerminalPaletteObservation } from "../../theme/terminalPalette/observation.js";
import { lightTerminalColors } from "../../theme/terminalPalette/test/fixtures.js";
import { createTerminalPaletteTheme } from "../../theme/terminalPalette/theme.js";
import { StationHoverProvider, StationMouseProvider } from "./stationMouseContext.js";
import { semanticItemRenderableId } from "./layout/scrollViewport.js";
import { FullscreenDashboard } from "../../dashboardRenderer/FullscreenDashboard.js";

function spanHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.fg === undefined ? undefined : rgbToHex(span.fg);
}

function spanBgHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.bg === undefined ? undefined : rgbToHex(span.bg);
}

const lightObservation = parseStationTerminalPaletteObservation(lightTerminalColors);
if (lightObservation === null) {
  throw new Error("Expected a complete light terminal palette fixture.");
}
const LIGHT_TERMINAL_THEME = createTerminalPaletteTheme(lightObservation);

const SIZES = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
  { width: 60, height: 16 },
  { width: 40, height: 12 },
] as const;

const BRAILLE_THROBBER_FRAME = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/gu;

function stableGoldenFrame(frame: string): string {
  return frame.replace(BRAILLE_THROBBER_FRAME, "⠋");
}

const SNAPSHOT_SCENARIOS: ReadonlyArray<{ name: string; snapshot: () => StationSnapshot }> = [
  { name: "many-projects", snapshot: manyProjectsSnapshot },
  { name: "grouped-many-projects", snapshot: groupedManyProjectsSnapshot },
  { name: "attention-and-failures", snapshot: attentionAndFailuresSnapshot },
  { name: "no-projects", snapshot: noProjectsSnapshot },
];

type RenderedDashboard = Awaited<ReturnType<typeof testRender>> & {
  store: ReturnType<typeof makeStationTestRuntime>["runtime"];
};

const WORKTREE_ERROR_MESSAGE =
  "Worktrunk failed to remove the selected checkout because the main worktree cannot be removed while Station is running there.";
const WORKTREE_ERROR_HINT =
  "Open a different linked checkout, select the session again, and retry after confirming the worktree path and branch.";
const WORKTREE_ERROR: ClientNotice = {
  kind: "error",
  message: WORKTREE_ERROR_MESSAGE,
  hint: WORKTREE_ERROR_HINT,
  traceId: "trace_worktree_remove_123",
  diagnosticId: "diag_worktree_remove_456",
};

function pendingDashboardCapabilities(): DashboardCapabilities {
  const execution = {
    optimistic: "none" as const,
    successDisposition: "remove-immediately" as const,
    completion: new Promise<never>(() => {}),
  };
  return {
    activation: { activate: () => execution },
    managedSessions: {
      create: () => execution,
      fork: () => execution,
      quickCreate: () => execution,
    },
    worktreeRemoval: { remove: () => execution },
    shell: { open: () => execution },
    dismissal: {
      dismissDashboard: () => execution,
      exitRenderer: () => execution,
    },
  };
}

describe("dashboard golden frames", () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  async function renderDashboard(input: {
    width: number;
    height: number;
    snapshot?: StationSnapshot;
    connection?: StationClientConnectionState;
    dispatchMouse?: (target: StationMouseTarget) => void;
    hoverEnabled?: boolean;
    toast?: ClientNotice;
    theme?: StationTheme;
    capabilities?: DashboardCapabilities;
    initialState?: DashboardRuntimeOptions["initialState"];
  }): Promise<RenderedDashboard> {
    const { runtime: store } = makeStationTestRuntime({
      snapshot: input.snapshot ?? null,
      connection: input.connection,
      seedInitialSnapshot: false,
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      ...(input.initialState === undefined ? {} : { initialState: input.initialState }),
    });
    store.start();
    const dashboard = (
      <DashboardRoot
        state={store.state}
        actions={store.actions}
        layout={store.layout}
        columns={input.width}
        rows={input.height}
        onCopyNotice={() => {}}
      />
    );
    const mouseDashboard =
      input.dispatchMouse === undefined ? (
        dashboard
      ) : (
        <StationMouseProvider value={(target) => input.dispatchMouse?.(target)}>
          {dashboard}
        </StationMouseProvider>
      );
    const setup = await testRender(
      <StationThemeProvider theme={input.theme ?? nativeStationTheme}>
        <StationHoverProvider value={input.hoverEnabled ?? true}>
          {mouseDashboard}
        </StationHoverProvider>
      </StationThemeProvider>,
      { width: input.width, height: input.height },
    );
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();
    await setup.flush();
    const toast = input.toast;
    if (toast !== undefined) {
      await act(async () => {
        store.actions.pushToast(toast);
        await Promise.resolve();
      });
      await setup.flush();
    }
    return Object.assign(setup, { store });
  }

  for (const scenario of SNAPSHOT_SCENARIOS) {
    for (const size of SIZES) {
      it(`renders ${scenario.name} at ${size.width}x${size.height}`, async () => {
        const setup = await renderDashboard({ ...size, snapshot: scenario.snapshot() });
        expect(stableGoldenFrame(setup.captureCharFrame())).toMatchSnapshot();
      });
    }
  }

  it("renders Group frames, counts, empty Groups, continuous slots, collapse, and both ordering modes", async () => {
    const snapshot = groupedManyProjectsSnapshot();
    const groupsFirst = await renderDashboard({ width: 120, height: 40, snapshot });
    const groupsFirstFrame = groupsFirst.captureCharFrame();
    const groupsFirstLines = groupsFirstFrame.split("\n");

    expect(groupsFirstFrame).toContain("▼ station  12 sessions · 6 Groups · 11 agents");
    expect(groupsFirstFrame).toContain("▼ Design refresh 2 sessions");
    expect(groupsFirstFrame).toContain("▼ Post-launch 0 sessions");
    expect(groupsFirstFrame).toContain("[9]");
    expect(groupsFirstFrame).toContain("[a]");
    expect(groupsFirstFrame).toContain("[b]");
    expect(groupsFirstFrame).toContain("[c]");
    const emptyHeader = groupsFirstLines.findIndex((line) => line.includes("▼ Post-launch"));
    expect(groupsFirstLines[emptyHeader + 1]?.trim()).toMatch(/^╰─+╯$/u);

    const collapsed = await renderDashboard({
      width: 120,
      height: 40,
      snapshot,
      initialState: { collapsedGroupIds: ["group_runtime_cleanup"] },
    });
    expect(collapsed.captureCharFrame()).toContain("▶ Runtime cleanup 1 session");
    expect(collapsed.captureCharFrame()).not.toContain("runtime-cleanup");
    expect(collapsed.captureCharFrame()).toContain("[b]");
    expect(collapsed.captureCharFrame()).not.toContain("[c]");
    expect(stableGoldenFrame(collapsed.captureCharFrame())).toMatchSnapshot();

    const interleaved = await renderDashboard({
      width: 120,
      height: 40,
      snapshot,
      initialState: { groupOrderingMode: "alphabetical-interleaved" },
    });
    const interleavedLines = interleaved.captureCharFrame().split("\n");
    const design = interleavedLines.findIndex((line) => line.includes("▼ Design refresh"));
    const docs = interleavedLines.findIndex((line) => line.includes("docs-refresh"));
    const input = interleavedLines.findIndex((line) => line.includes("▼ Input parity"));
    expect(design).toBeLessThan(docs);
    expect(docs).toBeLessThan(input);
    expect(stableGoldenFrame(interleaved.captureCharFrame())).toMatchSnapshot();
  });

  it("keeps a targeted Quick Session inside its semantic Group and Project boxes", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 40,
      snapshot: groupedManyProjectsSnapshot(),
      initialState: {
        localRows: {
          pendingCreate: [
            {
              localId: "create:station:quick-group",
              projectId: "station",
              title: "station-quick-group",
              branch: "station-quick-group",
              harnessProvider: "codex",
              targetGroupId: "group_post_launch",
              createdAt: "2026-08-11T00:00:00.000Z",
            },
          ],
          failedCreate: [],
          pendingRemove: [],
          pendingStart: [],
        },
      },
    });
    const lines = setup.captureCharFrame().split("\n");
    const firstLine = lines.findIndex((line) => line.includes("station-quick-group"));
    const pending = setup.renderer.root.findDescendantById(
      semanticItemRenderableId(dashboardRowIds.create("create:station:quick-group")),
    );
    const group = setup.renderer.root.findDescendantById(
      "station-dashboard-group:group:group_post_launch",
    );

    expect(pending?.height).toBe(1);
    expect(group).toBeDefined();
    expect(hasAncestor(pending, "station-dashboard-group:group:group_post_launch")).toBe(true);
    expect(hasAncestor(group, "station-dashboard-project:project:station")).toBe(true);
    expect(lines[firstLine]?.startsWith("│")).toBe(true);
    expect(lines[firstLine]?.trimEnd().endsWith("│")).toBe(true);
  });

  it("lays out mixed-height children and follows semantic focus through resize and reflow", async () => {
    const failedId = dashboardRowIds.create("failed-layout-proof");
    const focusedId = dashboardRowIds.session("ses_wt_scripts_unknown");
    const { runtime: store } = makeStationTestRuntime({
      snapshot: manyProjectsSnapshot(),
      seedInitialSnapshot: false,
      initialState: {
        localRows: {
          pendingCreate: [],
          failedCreate: [
            {
              localId: "failed-layout-proof",
              projectId: "station",
              title: "failed-layout-child",
              branch: "failed-layout-child",
              error: {
                tag: "ClientObserverError",
                code: "CREATE_FAILED",
                message: "Failure detail occupies its own intrinsic child box.",
              },
              expiresAt: Date.now() + 60_000,
            },
          ],
          pendingRemove: [],
          pendingStart: [],
        },
      },
    });
    store.start();
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <FullscreenDashboard
          runtime={store}
          openUrl={() => {}}
          onCopyNotice={() => {}}
        />
      </StationThemeProvider>,
      { width: 80, height: 16 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();
    await setup.flush();
    const failedRenderable = setup.renderer.root.findDescendantById(
      semanticItemRenderableId(failedId),
    );
    const initialLines = setup.captureCharFrame().split("\n");
    const failedTitle = initialLines.findIndex((line) => line.includes("failed-layout-child"));

    expect(failedRenderable?.height).toBe(2);
    expect(initialLines[failedTitle + 1]).toContain(
      "Failure detail occupies its own intrinsic child box.",
    );

    store.actions.focusDashboardSession("ses_wt_scripts_unknown");
    await setup.flush();
    expect(store.layout.snapshot()).toContain(focusedId);

    await act(async () => setup.renderer.resize(60, 10));
    await setup.renderOnce();
    await setup.flush();
    expect(store.layout.snapshot()).toContain(focusedId);

    store.actions.dispatch({
      type: "dashboard.cell.activate",
      rowId: dashboardRowIds.project("station"),
      cellId: "identity",
    });
    store.actions.focusDashboardSession("ses_wt_scripts_unknown");
    await setup.flush();
    await setup.flush();

    expect(store.state.getState().collapsedProjectIds.has("station")).toBe(true);
    expect(store.layout.snapshot()).toContain(focusedId);
  });

  it("renders filtered Group counts and clips structural Group boxes", async () => {
    const snapshot = groupedManyProjectsSnapshot();
    const filtered = await renderDashboard({
      width: 80,
      height: 40,
      snapshot,
      initialState: { persistentFilter: { query: "no-such-session" } },
    });
    const filteredFrame = filtered.captureCharFrame();

    expect(filteredFrame).toContain("▼ Design refresh 0 visible");
    expect(filteredFrame).toContain("▼ Post-launch 0 sessions");
    expect(filteredFrame).not.toContain("group-contracts");
    expect(stableGoldenFrame(filteredFrame)).toMatchSnapshot();

    const scrolled = await renderDashboard({
      width: 80,
      height: 16,
      snapshot,
    });
    scrolled.store.layout.scrollBy(8);
    await scrolled.flush();
    const scrolledFrame = scrolled.captureCharFrame();
    expect(scrolledFrame).toContain("▲");
    expect(scrolledFrame).toContain("│");
    expect(stableGoldenFrame(scrolledFrame)).toMatchSnapshot();
  });

  it("uses the same responsive Quick Session label for Group and Project headers", async () => {
    for (const { width, label, absent } of [
      { width: 80, label: "[qs]", absent: "[quick session]" },
      { width: 120, label: "[quick session]", absent: "[qs]" },
    ]) {
      const setup = await renderDashboard({
        width,
        height: 24,
        snapshot: groupedManyProjectsSnapshot(),
      });
      const lines = setup.captureCharFrame().split("\n");
      const projectLine = lines.find((line) => line.includes("▼ station"));
      const groupLine = lines.find((line) => line.includes("▼ Design refresh"));

      expect(projectLine).toContain(label);
      expect(projectLine).not.toContain(absent);
      expect(groupLine).toContain(label);
      expect(groupLine).not.toContain(absent);
    }
  });

  it("clips wide Project and Group names without shifting structural or action cells", async () => {
    const base = groupedManyProjectsSnapshot();
    const wideName = "界e\u0301 layout surface with a long semantic name";
    const wideGroupName = `A ${wideName}`;
    const setup = await renderDashboard({
      width: 40,
      height: 16,
      snapshot: {
        ...base,
        projects: base.projects.map((project) => ({ ...project, label: wideName })),
        sessionGroups: base.sessionGroups.map((group) =>
          group.id === "group_design_refresh" ? { ...group, name: wideGroupName } : group,
        ),
      },
    });
    const lines = setup.captureCharFrame().split("\n");
    const project = lines.find((line) => line.includes("▼ 界e\u0301"));
    const group = lines.find((line) => line.includes("▼ A 界e\u0301") && line.startsWith("│"));

    expect(project).toBeDefined();
    expect(group).toBeDefined();
    expect(project).not.toContain("�");
    expect(group).not.toContain("�");
    expect(project?.trimEnd().endsWith("[sh] [qs] [▾]")).toBe(true);
    expect(group?.trimEnd().endsWith("[qs] [▾]│")).toBe(true);
    expect(cellWidth(project ?? "")).toBe(40);
    expect(cellWidth(group ?? "")).toBe(40);
  });

  it("paints exact Group focus targets and focused-member containment", async () => {
    const snapshot = groupedManyProjectsSnapshot();
    for (const [targetIndex, cellId] of ["identity", "quickSession", "menu"].entries()) {
      const setup = await renderDashboard({
        width: 80,
        height: 24,
        snapshot,
      });
      await act(async () => {
        setup.store.actions.handleKey({ input: "", downArrow: true });
        setup.store.actions.handleKey({ input: "", downArrow: true });
        for (let index = 0; index < targetIndex; index += 1) {
          setup.store.actions.handleKey({ input: "", rightArrow: true });
        }
        await Promise.resolve();
      });
      await setup.flush();
      const lines = setup.captureCharFrame().split("\n");
      const row = lines.findIndex((line) => line.includes("▼ Design refresh"));
      const line = lines[row] ?? "";
      const samples = {
        identity: line.indexOf("Design refresh"),
        quickSession: line.indexOf("[qs]"),
        menu: line.indexOf("[▾]"),
      } as const;
      const markerColumns = {
        identity: line.indexOf("▼ Design refresh") - 1,
        quickSession: samples.quickSession - 1,
        menu: samples.menu - 1,
      } as const;
      const spans = setup.captureSpans();
      const focusMarkerColumn = line.indexOf("▸");

      expect(spanHex(spanAtFrameCell(spans, row, 0))).toBe(
        stationColorSnapshotValue(nativeStationTheme.status.working),
      );
      expect((spanAtFrameCell(spans, row, 0)?.attributes ?? 0) & TextAttributes.DIM).toBe(0);
      expect(line.match(/▸/gu)).toHaveLength(1);
      expect(focusMarkerColumn).toBeGreaterThan(0);
      expect(focusMarkerColumn).toBe(markerColumns[cellId as keyof typeof markerColumns]);
      for (const [target, column] of Object.entries(samples)) {
        expect(column).toBeGreaterThan(0);
        const background = spanBgHex(spanAtFrameCell(spans, row, column));
        if (target === cellId) {
          expect(background).toBe(
            stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
          );
        } else {
          expect(background).not.toBe(
            stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
          );
        }
      }
    }

    const member = await renderDashboard({
      width: 80,
      height: 24,
      snapshot,
    });
    await act(async () => {
      for (let index = 0; index < 3; index += 1) {
        member.store.actions.handleKey({ input: "", downArrow: true });
      }
      await Promise.resolve();
    });
    await member.flush();
    const memberLines = member.captureCharFrame().split("\n");
    const headerRow = memberLines.findIndex((line) => line.includes("▼ Design refresh"));
    const memberRow = memberLines.findIndex((line) => line.includes("group-contracts"));
    const memberColumn = memberLines[memberRow]?.indexOf("group-contracts") ?? -1;
    const spans = member.captureSpans();
    const ring = spanAtFrameCell(spans, headerRow, 0);

    expect(spanHex(ring)).toBe(stationColorSnapshotValue(nativeStationTheme.status.working));
    expect(((ring?.attributes ?? 0) & TextAttributes.DIM) !== 0).toBe(false);
    expect(memberLines[memberRow]).toMatch(/^│▏/u);
    expect(memberLines[memberRow]?.match(/▏/gu)).toHaveLength(1);
    expect(spanBgHex(spanAtFrameCell(spans, memberRow, memberColumn))).toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.keyboardFocus),
    );
  });

  it("renders only enabled Group header actions in expanded and collapsed layouts", async () => {
    const cases = [
      {
        visibility: { quickSession: true, menu: true },
        quickSession: true,
        menu: true,
        expandedSuffix: "[qs] [▾]│",
      },
      {
        visibility: { quickSession: true, menu: false },
        quickSession: true,
        menu: false,
        expandedSuffix: "[qs]│",
      },
      {
        visibility: { quickSession: false, menu: true },
        quickSession: false,
        menu: true,
        expandedSuffix: "[▾]│",
      },
      {
        visibility: { quickSession: false, menu: false },
        quickSession: false,
        menu: false,
        expandedSuffix: "│",
      },
    ] as const;

    for (const collapsed of [false, true]) {
      for (const testCase of cases) {
        const setup = await renderDashboard({
          width: 80,
          height: 24,
          snapshot: groupedManyProjectsSnapshot(),
          initialState: {
            groupHeaderActionVisibility: testCase.visibility,
            ...(collapsed ? { collapsedGroupIds: ["group_design_refresh"] } : {}),
          },
        });
        const line = setup
          .captureCharFrame()
          .split("\n")
          .find((candidate) => candidate.includes("Design refresh"));

        expect(line).toBeDefined();
        expect(line?.includes("[qs]")).toBe(testCase.quickSession);
        expect(line?.includes("[▾]")).toBe(testCase.menu);
        if (!collapsed) {
          expect(line?.trimEnd().endsWith(testCase.expandedSuffix)).toBe(true);
          expect(line?.lastIndexOf("│")).toBe(78);
        }
      }
    }
  });

  it("keeps Group frame cells inert and restores target focus after hover", async () => {
    const targets: StationMouseTarget[] = [];
    const groupId = dashboardRowIds.group("group_design_refresh");
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: groupedManyProjectsSnapshot(),
      dispatchMouse: (target) => targets.push(target),
    });
    await act(async () => {
      setup.store.actions.handleKey({ input: "", downArrow: true });
      setup.store.actions.handleKey({ input: "", downArrow: true });
      setup.store.actions.handleKey({ input: "", rightArrow: true });
      await Promise.resolve();
    });
    await setup.flush();
    const lines = setup.captureCharFrame().split("\n");
    const frame = setup.renderer.root.findDescendantById(
      `station-dashboard-group:${groupId}`,
    );
    const headerRow = lines.findIndex((line) => line.includes("▼ Design refresh"));
    const memberRow = lines.findIndex((line) => line.includes("group-contracts"));
    const frameEndRow = (frame?.screenY ?? 0) + (frame?.height ?? 0) - 1;
    const line = lines[headerRow] ?? "";
    const identity = line.indexOf("Design refresh");
    const quick = line.indexOf("[qs]");
    const menu = line.indexOf("[▾]");
    const leftEdge = frame?.screenX ?? 0;
    const rightEdge = leftEdge + (frame?.width ?? 0) - 1;
    const frameStartRow = frame?.screenY ?? 0;

    await setup.mockMouse.click(leftEdge, frameStartRow, MouseButtons.LEFT);
    await setup.mockMouse.click(Math.floor(rightEdge / 2), frameStartRow, MouseButtons.LEFT);
    await setup.mockMouse.click(leftEdge, headerRow, MouseButtons.LEFT);
    await setup.mockMouse.click(quick - 2, headerRow, MouseButtons.LEFT);
    await setup.mockMouse.click(
      cellWidth(line.slice(0, quick)) + cellWidth("[qs]"),
      headerRow,
      MouseButtons.LEFT,
    );
    await setup.mockMouse.click(rightEdge, headerRow, MouseButtons.LEFT);
    await setup.mockMouse.click(leftEdge, memberRow, MouseButtons.LEFT);
    await setup.mockMouse.click(rightEdge, memberRow, MouseButtons.LEFT);
    await setup.mockMouse.click(0, frameEndRow, MouseButtons.LEFT);
    await setup.mockMouse.click(Math.floor(rightEdge / 2), frameEndRow, MouseButtons.LEFT);
    await setup.mockMouse.click(identity, headerRow, MouseButtons.LEFT);
    await setup.mockMouse.click(quick, headerRow, MouseButtons.LEFT);
    await setup.mockMouse.click(menu, headerRow, MouseButtons.LEFT);

    expect(targets).toEqual([
      { kind: "dashboardCell", rowId: groupId, cellId: "identity" },
      { kind: "dashboardCell", rowId: groupId, cellId: "quickSession" },
      { kind: "dashboardCell", rowId: groupId, cellId: "menu" },
    ]);

    await act(async () => {
      await setup.mockMouse.moveTo(quick, headerRow);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();
    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), headerRow, quick))).toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );

    await act(async () => {
      await setup.mockMouse.moveTo(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();
    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), headerRow, quick))).toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
    );
  });

  it("renders the persistent filter soft-preview editor at wide width", async () => {
    const setup = await renderDashboard({
      width: 120,
      height: 40,
      snapshot: manyProjectsSnapshot(),
    });
    await act(async () => {
      setup.store.actions.handleKey({ input: "/" });
      setup.store.actions.handleKey({ input: "cli" });
      await Promise.resolve();
    });
    await setup.flush();

    const frame = setup.captureCharFrame();
    expect(stableGoldenFrame(frame)).toMatchSnapshot();
    expect(frame).toContain("FILTER /cli▏");
    expect(frame).toContain("FILTER");
    const lines = frame.split("\n");
    const matchingRow = lines.findIndex((line) => line.includes("cli-help-man"));
    const matchColumn = lines[matchingRow]?.indexOf("cli") ?? -1;
    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), matchingRow, matchColumn))).toBe(
      stationColorSnapshotValue(nativeStationTheme.filter.matchBackground),
    );
    const nonmatchingRow = lines.findIndex((line) => line.includes("pty-buffer"));
    const nonmatchColumn = lines[nonmatchingRow]?.indexOf("pty-buffer") ?? -1;
    const nonmatchSpan = spanAtFrameCell(setup.captureSpans(), nonmatchingRow, nonmatchColumn);
    expect(((nonmatchSpan?.attributes ?? 0) & TextAttributes.DIM) !== 0).toBe(true);
    const unmatchedProjectRow = lines.findIndex((line) => line.includes("▼ observer"));
    const unmatchedProjectColumn = lines[unmatchedProjectRow]?.indexOf("observer") ?? -1;
    const unmatchedProjectSpan = spanAtFrameCell(
      setup.captureSpans(),
      unmatchedProjectRow,
      unmatchedProjectColumn,
    );
    expect(((unmatchedProjectSpan?.attributes ?? 0) & TextAttributes.DIM) !== 0).toBe(true);
    const matchedProjectRow = lines.findIndex((line) => line.includes("▼ station"));
    const matchedProjectColumn = lines[matchedProjectRow]?.indexOf("station") ?? -1;
    const matchedProjectSpan = spanAtFrameCell(
      setup.captureSpans(),
      matchedProjectRow,
      matchedProjectColumn,
    );
    expect(((matchedProjectSpan?.attributes ?? 0) & TextAttributes.DIM) !== 0).toBe(false);
  });

  it("renders a recoverable zero-match persistent preview", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: manyProjectsSnapshot(),
    });
    await act(async () => {
      setup.store.actions.handleKey({ input: "/" });
      setup.store.actions.handleKey({ input: "no-such-session" });
      await Promise.resolve();
    });
    await setup.flush();

    expect(stableGoldenFrame(setup.captureCharFrame())).toMatchSnapshot();
    expect(setup.captureCharFrame()).toContain("0/10 matches");
  });

  it("renders an applied persistent summary at compact width", async () => {
    const setup = await renderDashboard({
      width: 60,
      height: 16,
      snapshot: manyProjectsSnapshot(),
    });
    await act(async () => {
      setup.store.actions.handleKey({ input: "/" });
      setup.store.actions.handleKey({ input: "working" });
      setup.store.actions.handleKey({ input: "i", ctrl: true });
      setup.store.actions.handleKey({ input: "S" });
      setup.store.actions.handleKey({ input: "3" });
      setup.store.actions.handleKey({ input: "\r", return: true });
      setup.store.actions.handleKey({ input: "F" });
      await Promise.resolve();
    });
    await setup.flush();
    await setup.flush();
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(stableGoldenFrame(frame)).toMatchSnapshot();
    expect(frame).toContain("FILTER working · Status=Working");
    expect(frame).toContain("▼ scripts");
    expect(frame).toContain("▼ empty-project");
    expect(frame).toContain("/ edit");
    expect(frame).toContain("Esc clear");
  });

  it("ignores branch metadata that is not visible in the dashboard row", async () => {
    const base = manyProjectsSnapshot();
    const snapshot = {
      ...base,
      rows: base.rows.map((row) =>
        row.id === "wt_station_idle2" ? { ...row, title: "Readable CLI task" } : row,
      ),
    };
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot,
    });
    await act(async () => {
      setup.store.actions.handleKey({ input: "/" });
      setup.store.actions.handleKey({ input: "cli-help-man" });
      setup.store.actions.handleKey({ input: "\r", return: true });
      await Promise.resolve();
    });
    await setup.flush();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("FILTER cli-help-man");
    expect(frame).toContain("0/10 matches");
    expect(frame).not.toContain("Readable CLI task");
    expect(frame).not.toContain("↳");
  });

  it("clips a long persistent draft at minimum dashboard size", async () => {
    const setup = await renderDashboard({
      width: 40,
      height: 12,
      snapshot: manyProjectsSnapshot(),
    });
    await act(async () => {
      setup.store.actions.handleKey({ input: "/" });
      setup.store.actions.handleKey({ input: "a-very-long-persistent-filter-draft" });
      await Promise.resolve();
    });
    await setup.flush();

    expect(stableGoldenFrame(setup.captureCharFrame())).toMatchSnapshot();
    expect(setup.captureCharFrame().split("\n")).toHaveLength(13);
  });

  it("renders the loading state", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      connection: { state: "loading", since: Date.now() },
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Loading observer snapshot...");
    expect(frame).toContain("Q/esc:close");
  });

  it("keeps dividers within the frame when loading resolves at 99x25", async () => {
    const width = 99;
    const height = 25;
    const divider = "─".repeat(width - 1);
    const { runtime: store, source } = makeStationTestRuntime({
      snapshot: null,
      connection: { state: "loading", since: Date.now() },
      seedInitialSnapshot: false,
    });
    store.start();
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <DashboardRoot state={store.state} actions={store.actions} layout={store.layout} columns={width} rows={height} onCopyNotice={() => {}} />
      </StationThemeProvider>,
      { width, height },
    );
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();

    const loadingLines = setup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd());
    expect(loadingLines[height - 2]).toBe(divider);
    expect(loadingLines[height - 1]).toBe("Q/esc:close");

    await act(async () => {
      source.setSnapshot(manyProjectsSnapshot());
      await Promise.resolve();
    });
    await setup.flush();

    const liveLines = setup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd());
    expect(liveLines[2]).toBe(divider);
    expect(liveLines[3]).toContain("SESSION");
    expect(liveLines[height - 2]).toBe(divider);
    expect(liveLines[height - 1]).toMatch(/^↵ activate/u);
    expect(liveLines.filter((line) => line === divider)).toHaveLength(2);
    expect(liveLines).not.toContain("─");
  });

  it("renders the waiting-for-observer state on cold reconnects", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      connection: {
        state: "reconnecting",
        since: Date.now(),
        lastError: {
          tag: "ProtocolError",
          code: "PROTOCOL_CONNECT_FAILED",
          message: "Could not connect to observer socket.",
        },
      },
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("waiting for observer");
    expect(frame).toContain("retrying connection");
    expect(frame).toContain("The dashboard will appear when the observer is ready.");
  });

  it("renders the parity-critical status presentation", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: attentionAndFailuresSnapshot(),
    });
    const frame = setup.captureCharFrame();
    // Status glyphs and labels from the parity checklist.
    expect(frame).toContain("! hook-scope");
    // Activity claims the row slack but is still bounded by the right-hand
    // metadata, so meaningful text truncates (later than before) at 80 cols.
    expect(frame).toContain("Agent needs appro…");
    expect(frame).toContain("⠋ pr-info");
    expect(frame).toContain("? metadata-refresh");
    expect(frame).toContain("x done-run");
    expect(frame).toContain("x2");
    expect(frame).toContain("✓");
    expect(frame).toContain("…");
    // Project headers with the disclosure marker and session/agent counts.
    expect(frame).toContain("▼ station  4 sessions");
    expect(frame).toContain("▼ observer  2 sessions");
  });

  it("renders external sessions while hiding bare worktrees", async () => {
    const snapshot = externalAgentSnapshot();
    const setup = await renderDashboard({ width: 120, height: 40, snapshot });
    const frame = setup.captureCharFrame();

    expect(frame).toContain("pty-buffer");
    expect(frame).toContain("docs-cleanup");
    expect(frame).not.toContain("old-experiment");
    expect(frame).toContain(`${snapshot.counts.sessions} sessions`);
  });

  it("colors alert rows red and check glyphs by state", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: attentionAndFailuresSnapshot(),
    });
    const charFrame = setup.captureCharFrame();
    const frame = setup.captureSpans();
    const lines = charFrame.split("\n");

    const attentionRow = lines.findIndex((line) => line.includes("! hook-scope"));
    expect(attentionRow).toBeGreaterThan(0);
    const markerCol = lines[attentionRow]?.indexOf("!") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, attentionRow, markerCol))).toBe(
      stationColorSnapshotValue(nativeStationTheme.status.danger),
    );

    const failGlyphCol = lines[attentionRow]?.lastIndexOf("x2") ?? -1;
    expect(failGlyphCol).toBeGreaterThan(0);
    expect(spanHex(spanAtFrameCell(frame, attentionRow, failGlyphCol))).toBe(
      stationColorSnapshotValue(nativeStationTheme.status.danger),
    );

    const prCol = lines[attentionRow]?.indexOf("#12") ?? -1;
    expect(prCol).toBeGreaterThan(0);
    const prSpan = spanAtFrameCell(frame, attentionRow, prCol);
    expect(spanHex(prSpan)).toBe(stationColorSnapshotValue(nativeStationTheme.status.working));
    expect(((prSpan?.attributes ?? 0) & TextAttributes.UNDERLINE) !== 0).toBe(true);
  });

  it("colours working rows blue and calm rows gray, leaving the name foreground", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: attentionAndFailuresSnapshot(),
    });
    const frame = setup.captureSpans();
    const lines = setup.captureCharFrame().split("\n");

    // Working row: the braille throbber (first frame ⠋) + the "working" label read
    // blue; the session name is not swept into the status colour.
    const workingRow = lines.findIndex((line) => line.includes("pr-info"));
    expect(workingRow).toBeGreaterThan(0);
    const throbberCol = lines[workingRow]?.indexOf("⠋") ?? -1;
    expect(throbberCol).toBeGreaterThan(0);
    expect(spanHex(spanAtFrameCell(frame, workingRow, throbberCol))).toBe(
      stationColorSnapshotValue(nativeStationTheme.status.working),
    );
    const workingWordCol = lines[workingRow]?.indexOf("working") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, workingRow, workingWordCol))).toBe(
      stationColorSnapshotValue(nativeStationTheme.status.working),
    );
    const workingNameCol = lines[workingRow]?.indexOf("pr-info") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, workingRow, workingNameCol))).not.toBe(
      stationColorSnapshotValue(nativeStationTheme.status.working),
    );

    // Calm (exited) row: the status label recedes to gray; the name does not.
    const exitedRow = lines.findIndex((line) => line.includes("done-run"));
    expect(exitedRow).toBeGreaterThan(0);
    const exitedWordCol = lines[exitedRow]?.indexOf("exited") ?? -1;
    expect(exitedWordCol).toBeGreaterThan(0);
    expect(spanHex(spanAtFrameCell(frame, exitedRow, exitedWordCol))).toBe(
      stationColorSnapshotValue(nativeStationTheme.text.muted),
    );
    const exitedNameCol = lines[exitedRow]?.indexOf("done-run") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, exitedRow, exitedNameCol))).not.toBe(
      stationColorSnapshotValue(nativeStationTheme.text.muted),
    );
  });

  it("keeps alert and unknown session names foreground while their status carries the colour", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: attentionAndFailuresSnapshot(),
    });
    const frame = setup.captureSpans();
    const lines = setup.captureCharFrame().split("\n");

    const attentionRow = lines.findIndex((line) => line.includes("hook-scope"));
    expect(attentionRow).toBeGreaterThan(0);
    const attentionNameCol = lines[attentionRow]?.indexOf("hook-scope") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, attentionRow, attentionNameCol))).toBe(
      stationColorSnapshotValue(nativeStationTheme.text.primary),
    );

    const unknownRow = lines.findIndex((line) => line.includes("metadata-refresh"));
    expect(unknownRow).toBeGreaterThan(0);
    const unknownWordCol = lines[unknownRow]?.indexOf("unknown") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, unknownRow, unknownWordCol))).toBe(
      stationColorSnapshotValue(nativeStationTheme.status.warning),
    );
    const unknownMarkCol = lines[unknownRow]?.indexOf("?") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, unknownRow, unknownMarkCol))).toBe(
      stationColorSnapshotValue(nativeStationTheme.status.warning),
    );
    const unknownNameCol = lines[unknownRow]?.indexOf("metadata-refresh") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, unknownRow, unknownNameCol))).toBe(
      stationColorSnapshotValue(nativeStationTheme.text.primary),
    );
  });

  it("keeps layout stable while applying representative light-terminal roles", async () => {
    const input = {
      width: 80,
      height: 24,
      snapshot: attentionAndFailuresSnapshot(),
    };
    const native = await renderDashboard(input);
    const light = await renderDashboard({ ...input, theme: LIGHT_TERMINAL_THEME });
    expect(light.captureCharFrame()).toBe(native.captureCharFrame());

    const lines = light.captureCharFrame().split("\n");
    const spans = light.captureSpans();
    const attentionRow = lines.findIndex((line) => line.includes("hook-scope"));
    const attentionName = lines[attentionRow]?.indexOf("hook-scope") ?? -1;
    const dangerMark = lines[attentionRow]?.indexOf("!") ?? -1;
    const exitedRow = lines.findIndex((line) => line.includes("done-run"));
    const mutedStatus = lines[exitedRow]?.indexOf("exited") ?? -1;

    expect(spanHex(spanAtFrameCell(spans, attentionRow, attentionName))).toBe(
      stationColorSnapshotValue(LIGHT_TERMINAL_THEME.text.primary),
    );
    expect(spanHex(spanAtFrameCell(spans, attentionRow, dangerMark))).toBe(
      stationColorSnapshotValue(LIGHT_TERMINAL_THEME.status.danger),
    );
    expect(spanHex(spanAtFrameCell(spans, exitedRow, mutedStatus))).toBe(
      stationColorSnapshotValue(LIGHT_TERMINAL_THEME.status.neutral),
    );
    expect(LIGHT_TERMINAL_THEME.surfaces.canvas.kind).toBe("terminal-default");
  });

  it("routes PR number clicks through the link mouse target", async () => {
    const targets: StationMouseTarget[] = [];
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: attentionAndFailuresSnapshot(),
      dispatchMouse: (target) => {
        targets.push(target);
      },
    });
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("! hook-scope"));
    const col = lines[row]?.indexOf("#12") ?? -1;
    expect(row).toBeGreaterThan(0);
    expect(col).toBeGreaterThan(0);

    const pointerCalls: string[] = [];
    const real = setup.renderer.setMousePointer.bind(setup.renderer);
    setup.renderer.setMousePointer = ((shape: string) => {
      pointerCalls.push(shape);
      real(shape as Parameters<typeof real>[0]);
    }) as typeof setup.renderer.setMousePointer;

    await setup.mockMouse.moveTo(col, row);
    expect(pointerCalls.at(-1)).toBe("pointer");

    await setup.mockMouse.click(col, row, MouseButtons.LEFT);

    expect(targets.at(-1)).toEqual({
      kind: "link",
      url: "https://github.com/example/station/pull/12",
    });

    await setup.mockMouse.moveTo(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pointerCalls.at(-1)).toBe("default");
  });

  it("renders and routes the first-project CTA with readable hover contrast", async () => {
    const targets: StationMouseTarget[] = [];
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: noProjectsSnapshot(),
      dispatchMouse: (target) => targets.push(target),
    });
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Add your first project"));
    const col = lines[row]?.indexOf("[") ?? -1;
    expect(row).toBeGreaterThan(0);
    expect(col).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await setup.mockMouse.moveTo(col + 2, row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();
    const hovered = spanAtFrameCell(setup.captureSpans(), row, col + 2);
    expect(spanHex(hovered)).toBe(stationColorSnapshotValue(nativeStationTheme.text.inverse));
    expect(spanBgHex(hovered)).toBe(stationColorSnapshotValue(nativeStationTheme.action.primary));

    await setup.mockMouse.click(col + 2, row, MouseButtons.LEFT);
    expect(targets.at(-1)).toEqual({ kind: "firstProjectAdd" });
  });

  it("assigns slots only to visible actionable rows", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 40,
      snapshot: manyProjectsSnapshot(),
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[1]");
    // The starting row gets a slot too (it has a focusable terminal), but the
    // empty project renders its calm empty-state line (with a click-to-add
    // button) and no slot cell.
    expect(frame).toContain("no sessions yet · ");
    expect(frame).toContain("[ + add session ]");
  });

  it("bounds empty-project focus, hover, and hit testing to Add Session cells", async () => {
    for (const width of [120, 80]) {
      const targets: StationMouseTarget[] = [];
      const setup = await renderDashboard({
        width,
        height: 40,
        snapshot: manyProjectsSnapshot(),
        dispatchMouse: (target) => targets.push(target),
        capabilities: pendingDashboardCapabilities(),
      });
      await act(async () => {
        setup.store.actions.dispatch({
          type: "dashboard.cell.activate",
          rowId: dashboardRowIds.empty("empty-project"),
          cellId: "addSession",
        });
      });
      await setup.flush();

      const lines = setup.captureCharFrame().split("\n");
      const row = lines.findIndex((line) => line.includes("[ + add session ]"));
      const col = lines[row]?.indexOf("[ + add session ]") ?? -1;
      const after = cellWidth((lines[row] ?? "").slice(0, col)) + cellWidth("[ + add session ]");
      expect(row).toBeGreaterThan(0);
      expect(col).toBeGreaterThan(0);

      let spans = setup.captureSpans();
      expect(spanBgHex(spanAtFrameCell(spans, row, col))).toBe(
        stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
      );
      expect(spanBgHex(spanAtFrameCell(spans, row, after - 1))).toBe(
        stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
      );
      expect(spanBgHex(spanAtFrameCell(spans, row, col - 1))).not.toBe(
        stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
      );
      expect(spanBgHex(spanAtFrameCell(spans, row, after))).not.toBe(
        stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
      );

      await act(async () => {
        await setup.mockMouse.moveTo(col, row);
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      await setup.flush();
      spans = setup.captureSpans();
      expect(spanHex(spanAtFrameCell(spans, row, col))).toBe(
        stationColorSnapshotValue(nativeStationTheme.text.inverse),
      );
      expect(spanBgHex(spanAtFrameCell(spans, row, col))).toBe(
        stationColorSnapshotValue(nativeStationTheme.action.primary),
      );

      await act(async () => {
        await setup.mockMouse.moveTo(0, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      await setup.flush();
      expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), row, col))).toBe(
        stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
      );

      await setup.mockMouse.click(col - 1, row, MouseButtons.LEFT);
      await setup.mockMouse.click(col, row, MouseButtons.LEFT);
      await setup.mockMouse.click(after, row, MouseButtons.LEFT);
      expect(targets).toEqual([
        {
          kind: "dashboardCell",
          rowId: dashboardRowIds.empty("empty-project"),
          cellId: "addSession",
        },
      ]);
    }
  });

  it("renders the focus cursor and jumps it to the next session needing you", async () => {
    const { runtime: store } = makeStationTestRuntime({
      snapshot: attentionAndFailuresSnapshot(),
      seedInitialSnapshot: false,
    });
    store.start();
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <DashboardRoot state={store.state} actions={store.actions} layout={store.layout} columns={80} rows={24} onCopyNotice={() => {}} />
      </StationThemeProvider>,
      { width: 80, height: 24 },
    );
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("▏");

    store.actions.handleKey({ input: "", downArrow: true });
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain("▏");

    store.actions.handleKey({ input: "", downArrow: true });
    await setup.flush();
    let lines = setup.captureCharFrame().split("\n");
    const cursorRow = lines.findIndex((line) => line.startsWith("▏"));
    expect(lines[cursorRow]).toContain("hook-scope");
    const spans = setup.captureSpans();
    expect(spanHex(spanAtFrameCell(spans, cursorRow, 0))).toBe(
      stationColorSnapshotValue(nativeStationTheme.action.primary),
    );
    expect(spanBgHex(spanAtFrameCell(spans, cursorRow, 0))).toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.keyboardFocus),
    );

    // Tab (Ctrl-I) jumps past the working/unknown rows to the stuck one.
    store.actions.handleKey({ input: "i", ctrl: true });
    await setup.flush();
    lines = setup.captureCharFrame().split("\n");
    expect(lines.find((line) => line.startsWith("▏"))).toContain("popup-latency");
  });

  it("paints only the focused project-header segment at wide and compact widths", async () => {
    for (const width of [120, 80]) {
      const setup = await renderDashboard({
        width,
        height: 24,
        snapshot: manyProjectsSnapshot(),
      });
      const shellLabel = width < 90 ? "[sh]" : "[shell]";
      const quickLabel = width < 90 ? "[qs]" : "[quick session]";
      const controls = ["primary", "shell", "quickSession", "menu"] as const;

      setup.store.actions.handleKey({ input: "", downArrow: true });
      for (let index = 0; index < controls.length; index += 1) {
        if (index > 0) {
          setup.store.actions.handleKey({ input: "", rightArrow: true });
        }
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const row = lines.findIndex((line) => line.includes("▼ station"));
        const line = lines[row] ?? "";
        const shellStart = line.indexOf(shellLabel);
        const quickStart = line.indexOf(quickLabel);
        const defaultStart = line.indexOf("[▾]");
        const primaryEnd = cellWidth(line.slice(0, shellStart - 1).trimEnd());
        expect(row).toBeGreaterThan(0);
        expect(line.trimStart()).toMatch(/^(?:▸)?▼ station/u);
        expect(line).not.toContain("▏");
        expect(line.match(/▸/gu)).toHaveLength(1);

        const spans = setup.captureSpans();
        const samples = {
          primary: 0,
          shell: shellStart,
          quickSession: quickStart,
          menu: defaultStart,
        } as const;
        const markerColumns = {
          primary: line.indexOf("▼ station") - 1,
          shell: shellStart - 1,
          quickSession: quickStart - 1,
          menu: defaultStart - 1,
        } as const;
        expect(line.indexOf("▸")).toBe(markerColumns[controls[index]]);
        for (const [control, column] of Object.entries(samples)) {
          const background = spanBgHex(spanAtFrameCell(spans, row, column));
          if (control === controls[index]) {
            expect(background).toBe(
              stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
            );
          } else {
            expect(background).not.toBe(
              stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
            );
          }
        }
        expect(spanBgHex(spanAtFrameCell(spans, row, primaryEnd))).not.toBe(
          stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
        );
        expect(spanBgHex(spanAtFrameCell(spans, row, shellStart - 1))).not.toBe(
          stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
        );
        expect(spanBgHex(spanAtFrameCell(spans, row, quickStart - 1))).not.toBe(
          stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
        );
        expect(spanBgHex(spanAtFrameCell(spans, row, defaultStart - 1))).not.toBe(
          stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
        );
      }
    }
  });

  it("bounds project-header hit targets to segment cells and leaves whitespace inert", async () => {
    const targets: StationMouseTarget[] = [];
    const setup = await renderDashboard({
      width: 120,
      height: 24,
      snapshot: manyProjectsSnapshot(),
      dispatchMouse: (target) => targets.push(target),
    });
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("▼ station"));
    const line = lines[row] ?? "";
    const shell = line.indexOf("[shell]");
    const quick = line.indexOf("[quick session]");
    const picker = line.indexOf("[▾]");
    const inert = cellWidth(line.slice(0, shell).trimEnd()) + 1;

    await setup.mockMouse.click(1, row, MouseButtons.LEFT);
    await setup.mockMouse.click(inert, row, MouseButtons.LEFT);
    await setup.mockMouse.click(shell - 1, row, MouseButtons.LEFT);
    await setup.mockMouse.click(quick - 1, row, MouseButtons.LEFT);
    await setup.mockMouse.click(picker - 1, row, MouseButtons.LEFT);
    await setup.mockMouse.click(shell, row, MouseButtons.LEFT);
    await setup.mockMouse.click(quick, row, MouseButtons.LEFT);
    await setup.mockMouse.click(picker, row, MouseButtons.LEFT);

    expect(targets).toEqual([
      {
        kind: "dashboardCell",
        rowId: dashboardRowIds.project("station"),
        cellId: "identity",
      },
      {
        kind: "dashboardCell",
        rowId: dashboardRowIds.project("station"),
        cellId: "shell",
      },
      {
        kind: "dashboardCell",
        rowId: dashboardRowIds.project("station"),
        cellId: "quickSession",
      },
      {
        kind: "dashboardCell",
        rowId: dashboardRowIds.project("station"),
        cellId: "menu",
      },
    ]);
  });

  it("lets project-header hover supersede and then reveal keyboard focus", async () => {
    const setup = await renderDashboard({
      width: 120,
      height: 24,
      snapshot: manyProjectsSnapshot(),
    });
    setup.store.actions.handleKey({ input: "", downArrow: true });
    setup.store.actions.handleKey({ input: "", rightArrow: true });
    await setup.flush();
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("▼ station"));
    const shell = lines[row]?.indexOf("[shell]") ?? -1;

    await setup.mockMouse.moveTo(shell, row);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), row, shell))).toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );

    await setup.mockMouse.moveTo(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), row, shell))).toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.compactFocus),
    );
  });

  it("paints hovered session rows through the trailing action column", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: manyProjectsSnapshot(),
    });
    const before = setup.captureCharFrame();
    const lines = before.split("\n");
    const row = lines.findIndex((line) => line.includes("docs-cleanup"));
    expect(row).toBeGreaterThan(0);
    const col = Math.max(0, lines[row]?.indexOf("docs-cleanup") ?? 0);

    await setup.mockMouse.moveTo(col, row);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();

    const spans = setup.captureSpans();
    expect(spanBgHex(spanAtFrameCell(spans, row, 78))).toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );
  });

  it("suppresses dashboard row hovers while the persistent filter editor owns input", async () => {
    const setup = await renderDashboard({
      width: 120,
      height: 24,
      snapshot: manyProjectsSnapshot(),
    });
    await act(async () => {
      setup.store.actions.handleKey({ input: "/" });
      await Promise.resolve();
    });
    await setup.flush();

    const lines = setup.captureCharFrame().split("\n");
    const projectRow = lines.findIndex((line) => line.includes("▼ station"));
    const shellColumn = lines[projectRow]?.indexOf("[shell]") ?? -1;
    await setup.mockMouse.moveTo(shellColumn, projectRow);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), projectRow, shellColumn))).not.toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );

    const sessionRow = lines.findIndex((line) => line.includes("docs-cleanup"));
    const sessionColumn = lines[sessionRow]?.indexOf("docs-cleanup") ?? -1;
    await setup.mockMouse.moveTo(sessionColumn, sessionRow);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), sessionRow, 118))).not.toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );
  });

  it("suppresses popup hover styling without removing click targets", async () => {
    let clicked: StationMouseTarget | undefined;
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: manyProjectsSnapshot(),
      hoverEnabled: false,
      dispatchMouse: (target) => {
        clicked = target;
      },
    });
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("docs-cleanup"));
    const col = Math.max(0, lines[row]?.indexOf("docs-cleanup") ?? 0);

    await setup.mockMouse.moveTo(col, row);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();

    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), row, 78))).not.toBe(
      stationColorSnapshotValue(nativeStationTheme.interaction.hover),
    );
    await setup.mockMouse.click(col, row, MouseButtons.LEFT);
    expect(clicked).toMatchObject({
      kind: "dashboardCell",
      cellId: "identity",
    });
  });

  it("wraps the complete actionable error at wide and narrow widths", async () => {
    for (const size of [
      { width: 99, height: 25 },
      { width: 40, height: 25 },
    ]) {
      const setup = await renderDashboard({
        ...size,
        snapshot: manyProjectsSnapshot(),
        toast: WORKTREE_ERROR,
      });
      const frame = setup.captureCharFrame();
      const lines = frame.split("\n");
      const surface = setup.renderer.root.findDescendantById("station-toast-surface");
      const noticeRegion = setup.renderer.root.findDescendantById(
        "station-dashboard-notice-region",
      );
      const controls = setup.renderer.root.findDescendantById("station-dashboard-controls");
      expect(surface).toBeDefined();
      expect(noticeRegion).toBeDefined();
      expect(controls).toBeDefined();
      if (surface === undefined || noticeRegion === undefined || controls === undefined) {
        throw new Error("toast surface, notice region, and dashboard controls must render");
      }
      const message = setup.renderer.root.findDescendantById(
        semanticItemRenderableId("toast:message"),
      );
      const detail = setup.renderer.root.findDescendantById(
        semanticItemRenderableId("toast:detail"),
      );
      expect(message).toBeDefined();
      expect(detail).toBeDefined();
      if (message === undefined || detail === undefined) {
        throw new Error("toast message and detail must remain mounted");
      }
      const noticeText = [message, detail]
        .flatMap((renderable) =>
          lines
            .slice(renderable.y, renderable.y + renderable.height)
            .map((line) => line.slice(renderable.x, renderable.x + renderable.width).trim()),
        )
        .join(" ")
        .replace(/\s+/g, " ");

      expect(surface.y).toBeGreaterThanOrEqual(noticeRegion.y);
      expect(surface.y + surface.height).toBeLessThanOrEqual(controls.y);
      expect(surface.height).toBeLessThan(noticeRegion.height);
      expect(surface.x).toBe(2 + Math.max(0, size.width - 76));
      expect(size.width - surface.x - surface.width).toBe(2);
      expect(noticeText).toContain(WORKTREE_ERROR_MESSAGE);
      expect(noticeText).toContain(WORKTREE_ERROR_HINT);
      expect(noticeText).toContain("trace trace_worktree_remove_123");
      expect(noticeText).toContain("diagnostic diag_worktree_remove_456");
      expect(noticeText).not.toContain("…");
      expect(frame).toContain("Esc:dismiss  Q:close");
      expect(stableGoldenFrame(frame.replace(/[ \t]+$/gm, ""))).toMatchSnapshot();
    }
  });
});

function hasAncestor(
  renderable: BaseRenderable | undefined,
  ancestorId: string,
): boolean {
  let current = renderable?.parent;
  while (current !== null && current !== undefined) {
    if (current.id === ancestorId) return true;
    current = current.parent;
  }
  return false;
}
