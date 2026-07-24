// Golden frames: every scenario at every surface size, captured immediately
// after first render (before the 120ms throbber tick) so the working-row
// throbber shows its first braille frame (⠋) deterministically.
import { afterEach, describe, expect, it } from "bun:test";
import { BaseRenderable, rgbToHex, TextAttributes, TextRenderable } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { StationClientConnectionState } from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import type { TuiToast } from "@station/dashboard-core";
import { act } from "react";
import { spanAtFrameCell } from "../../terminal/testing/frameProbe.js";
import {
  attentionAndFailuresSnapshot,
  externalAgentSnapshot,
  manyProjectsSnapshot,
  noProjectsSnapshot,
} from "../fixtures/scenarios.js";
import { makeStationTestStore } from "../test/support/makeStationTestStore.js";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { DashboardRoot } from "./DashboardRoot.js";
import { STATION_COLORS } from "./theme.js";
import { StationHoverProvider, StationMouseProvider } from "./stationMouseContext.js";

function spanHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.fg === undefined ? undefined : rgbToHex(span.fg);
}

function spanBgHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.bg === undefined ? undefined : rgbToHex(span.bg);
}

const SIZES = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
  { width: 60, height: 16 },
  { width: 40, height: 12 },
] as const;

const SNAPSHOT_SCENARIOS: ReadonlyArray<{ name: string; snapshot: () => StationSnapshot }> = [
  { name: "many-projects", snapshot: manyProjectsSnapshot },
  { name: "attention-and-failures", snapshot: attentionAndFailuresSnapshot },
  { name: "no-projects", snapshot: noProjectsSnapshot },
];

type RenderedDashboard = Awaited<ReturnType<typeof testRender>> & {
  store: ReturnType<typeof makeStationTestStore>["store"];
};

const WORKTREE_ERROR_MESSAGE =
  "Worktrunk failed to remove the selected checkout because the main worktree cannot be removed while Station is running there.";
const WORKTREE_ERROR_HINT =
  "Open a different linked checkout, select the session again, and retry after confirming the worktree path and branch.";
const WORKTREE_ERROR: TuiToast = {
  kind: "error",
  message: WORKTREE_ERROR_MESSAGE,
  hint: WORKTREE_ERROR_HINT,
  traceId: "trace_worktree_remove_123",
  diagnosticId: "diag_worktree_remove_456",
};

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
    toast?: TuiToast;
  }): Promise<RenderedDashboard> {
    const { store } = makeStationTestStore({
      snapshot: input.snapshot ?? null,
      connection: input.connection,
      seedInitialSnapshot: false,
    });
    store.getState().start();
    const dashboard = (
      <DashboardRoot
        store={store}
        columns={input.width}
        rows={input.height}
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
      <StationHoverProvider value={input.hoverEnabled ?? true}>
        {mouseDashboard}
      </StationHoverProvider>,
      { width: input.width, height: input.height },
    );
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();
    const toast = input.toast;
    if (toast !== undefined) {
      await act(async () => {
        store.getState().pushToast(toast);
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
        expect(setup.captureCharFrame()).toMatchSnapshot();
      });
    }
  }

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
    const { store, source } = makeStationTestStore({
      snapshot: null,
      connection: { state: "loading", since: Date.now() },
      seedInitialSnapshot: false,
    });
    store.getState().start();
    const setup = await testRender(<DashboardRoot store={store} columns={width} rows={height} />, {
      width,
      height,
    });
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();

    const loadingLines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
    expect(loadingLines[height - 2]).toBe(divider);
    expect(loadingLines[height - 1]).toBe("Q/esc:close");

    await act(async () => {
      source.setSnapshot(manyProjectsSnapshot());
      await Promise.resolve();
    });
    await setup.flush();

    const liveLines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
    expect(liveLines[2]).toBe(divider);
    expect(liveLines[3]).toContain("SESSION");
    expect(liveLines[height - 2]).toBe(divider);
    expect(liveLines[height - 1]).toMatch(/^↵ open/u);
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
    expect(spanHex(spanAtFrameCell(frame, attentionRow, markerCol))).toBe(STATION_COLORS.red);

    const failGlyphCol = lines[attentionRow]?.lastIndexOf("x2") ?? -1;
    expect(failGlyphCol).toBeGreaterThan(0);
    expect(spanHex(spanAtFrameCell(frame, attentionRow, failGlyphCol))).toBe(STATION_COLORS.red);

    const prCol = lines[attentionRow]?.indexOf("#12") ?? -1;
    expect(prCol).toBeGreaterThan(0);
    const prSpan = spanAtFrameCell(frame, attentionRow, prCol);
    expect(spanHex(prSpan)).toBe(STATION_COLORS.blue);
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
    expect(spanHex(spanAtFrameCell(frame, workingRow, throbberCol))).toBe(STATION_COLORS.blue);
    const workingWordCol = lines[workingRow]?.indexOf("working") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, workingRow, workingWordCol))).toBe(STATION_COLORS.blue);
    const workingNameCol = lines[workingRow]?.indexOf("pr-info") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, workingRow, workingNameCol))).not.toBe(STATION_COLORS.blue);

    // Calm (exited) row: the status label recedes to gray; the name does not.
    const exitedRow = lines.findIndex((line) => line.includes("done-run"));
    expect(exitedRow).toBeGreaterThan(0);
    const exitedWordCol = lines[exitedRow]?.indexOf("exited") ?? -1;
    expect(exitedWordCol).toBeGreaterThan(0);
    expect(spanHex(spanAtFrameCell(frame, exitedRow, exitedWordCol))).toBe(STATION_COLORS.gray);
    const exitedNameCol = lines[exitedRow]?.indexOf("done-run") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, exitedRow, exitedNameCol))).not.toBe(STATION_COLORS.gray);
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
      STATION_COLORS.foreground,
    );

    const unknownRow = lines.findIndex((line) => line.includes("metadata-refresh"));
    expect(unknownRow).toBeGreaterThan(0);
    const unknownWordCol = lines[unknownRow]?.indexOf("unknown") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, unknownRow, unknownWordCol))).toBe(STATION_COLORS.yellow);
    const unknownMarkCol = lines[unknownRow]?.indexOf("?") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, unknownRow, unknownMarkCol))).toBe(STATION_COLORS.yellow);
    const unknownNameCol = lines[unknownRow]?.indexOf("metadata-refresh") ?? -1;
    expect(spanHex(spanAtFrameCell(frame, unknownRow, unknownNameCol))).toBe(
      STATION_COLORS.foreground,
    );
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

  it("assigns slots only to visible actionable rows", async () => {
    const setup = await renderDashboard({ width: 80, height: 40, snapshot: manyProjectsSnapshot() });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[1]");
    // The starting row gets a slot too (it has a focusable terminal), but the
    // empty project renders its calm empty-state line (with a click-to-add
    // button) and no slot cell.
    expect(frame).toContain("no sessions yet · ");
    expect(frame).toContain("[ + add session ]");
  });

  it("keeps the empty-project add-session action readable on hover", async () => {
    const setup = await renderDashboard({ width: 120, height: 40, snapshot: manyProjectsSnapshot() });
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("[ + add session ]"));
    const col = lines[row]?.indexOf("[ + add session ]") ?? -1;
    expect(row).toBeGreaterThan(0);
    expect(col).toBeGreaterThan(0);

    const ordinarySpan = spanAtFrameCell(setup.captureSpans(), row, col);
    const ordinaryForeground = spanHex(ordinarySpan);
    const ordinaryBackground = spanBgHex(ordinarySpan);
    expect(ordinaryForeground).toBe(STATION_COLORS.cyan);
    expect(ordinaryForeground).not.toBe(ordinaryBackground);

    await act(async () => {
      await setup.mockMouse.moveTo(col, row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    const hoveredSpan = spanAtFrameCell(setup.captureSpans(), row, col);
    const hoveredForeground = spanHex(hoveredSpan);
    const hoveredBackground = spanBgHex(hoveredSpan);
    expect(hoveredForeground).toBe(STATION_COLORS.background);
    expect(hoveredBackground).toBe(STATION_COLORS.cyan);
    expect(hoveredForeground).not.toBe(hoveredBackground);

    await act(async () => {
      await setup.mockMouse.moveTo(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    const restoredSpan = spanAtFrameCell(setup.captureSpans(), row, col);
    expect(spanHex(restoredSpan)).toBe(ordinaryForeground);
    expect(spanBgHex(restoredSpan)).toBe(ordinaryBackground);
  });

  it("renders the focus cursor and jumps it to the next session needing you", async () => {
    const { store } = makeStationTestStore({
      snapshot: attentionAndFailuresSnapshot(),
      seedInitialSnapshot: false,
    });
    store.getState().start();
    const setup = await testRender(<DashboardRoot store={store} columns={80} rows={24} />, {
      width: 80,
      height: 24,
    });
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("▏");

    store.getState().handleKey({ input: "", downArrow: true });
    await setup.flush();
    let lines = setup.captureCharFrame().split("\n");
    const cursorRow = lines.findIndex((line) => line.startsWith("▏"));
    expect(lines[cursorRow]).toContain("hook-scope");
    const spans = setup.captureSpans();
    expect(spanHex(spanAtFrameCell(spans, cursorRow, 0))).toBe(STATION_COLORS.cyan);
    expect(spanBgHex(spanAtFrameCell(spans, cursorRow, 0))).toBe(STATION_COLORS.focusBackground);

    // Tab (Ctrl-I) jumps past the working/unknown rows to the stuck one.
    store.getState().handleKey({ input: "i", ctrl: true });
    await setup.flush();
    lines = setup.captureCharFrame().split("\n");
    expect(lines.find((line) => line.startsWith("▏"))).toContain("popup-latency");
  });

  it("paints hovered session rows through the trailing action column", async () => {
    const setup = await renderDashboard({ width: 80, height: 24, snapshot: manyProjectsSnapshot() });
    const before = setup.captureCharFrame();
    const lines = before.split("\n");
    const row = lines.findIndex((line) => line.includes("docs-cleanup"));
    expect(row).toBeGreaterThan(0);
    const col = Math.max(0, lines[row]?.indexOf("docs-cleanup") ?? 0);

    await setup.mockMouse.moveTo(col, row);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();

    const spans = setup.captureSpans();
    expect(spanBgHex(spanAtFrameCell(spans, row, 78))).toBe(STATION_COLORS.hoverBackground);
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
      STATION_COLORS.hoverBackground,
    );
    await setup.mockMouse.click(col, row, MouseButtons.LEFT);
    expect(clicked).toMatchObject({ kind: "row" });
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
      const top = lines.findIndex((line) => line.includes("┌"));
      const bottom = lines.findIndex((line, index) => index > top && line.includes("└"));
      const left = lines[top]?.indexOf("┌") ?? -1;
      const right = lines[top]?.lastIndexOf("┐") ?? -1;
      const noticeText = lines
        .slice(top + 1, bottom)
        .map((line) => line.slice(left + 1, right).trim())
        .join(" ")
        .replace(/\s+/g, " ");

      expect(top).toBeGreaterThanOrEqual(3);
      expect(bottom).toBeLessThan(size.height - 3);
      expect(left).toBe(2 + Math.max(0, size.width - 76));
      expect(size.width - right - 1).toBe(2);
      expect(noticeText).toContain(WORKTREE_ERROR_MESSAGE);
      expect(noticeText).toContain(WORKTREE_ERROR_HINT);
      expect(noticeText).toContain("trace trace_worktree_remove_123");
      expect(noticeText).toContain("diagnostic diag_worktree_remove_456");
      expect(noticeText).not.toContain("…");
      expect(frame).toContain("Esc:dismiss  Q:close");
      expect(frame.replace(/[ \t]+$/gm, "")).toMatchSnapshot();
    }
  });

  it("keeps notice text selectable and dismisses only from the dismiss control", async () => {
    const targets: StationMouseTarget[] = [];
    let setup: RenderedDashboard;
    setup = await renderDashboard({
      width: 99,
      height: 25,
      snapshot: manyProjectsSnapshot(),
      toast: WORKTREE_ERROR,
      dispatchMouse: (target) => {
        targets.push(target);
        if (target.kind === "toast") {
          setup.store.getState().dismissToasts();
        }
      },
    });
    let lines = setup.captureCharFrame().split("\n");
    const messageRow = lines.findIndex((line) => line.includes("Worktrunk failed"));
    const messageColumn = lines[messageRow]?.indexOf("Worktrunk") ?? -1;
    const dismissRow = lines.findIndex((line) => line.includes("[ dismiss ]"));
    const dismissColumn = lines[dismissRow]?.indexOf("[ dismiss ]") ?? -1;
    expect(messageRow).toBeGreaterThan(0);
    expect(messageColumn).toBeGreaterThan(0);
    expect(dismissRow).toBeGreaterThan(0);
    expect(dismissColumn).toBeGreaterThan(0);

    const textRenderables = collectTextRenderables(setup.renderer.root);
    const selectableCopy = textRenderables.filter(
      (renderable) =>
        renderable.plainText === WORKTREE_ERROR_MESSAGE ||
        renderable.plainText.includes(WORKTREE_ERROR_HINT),
    );
    expect(selectableCopy).toHaveLength(2);
    expect(selectableCopy.every((renderable) => renderable.selectable)).toBe(true);

    await setup.mockMouse.click(messageColumn, messageRow, MouseButtons.LEFT);
    await setup.flush();
    expect(targets).toEqual([]);
    expect(setup.store.getState().toasts).toHaveLength(1);

    const ordinaryDismiss = spanAtFrameCell(setup.captureSpans(), dismissRow, dismissColumn);
    await act(async () => {
      await setup.mockMouse.moveTo(dismissColumn, dismissRow);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();
    const hoveredDismiss = spanAtFrameCell(setup.captureSpans(), dismissRow, dismissColumn);
    expect(spanHex(hoveredDismiss)).not.toBe(spanHex(ordinaryDismiss));
    expect(spanBgHex(hoveredDismiss)).not.toBe(spanBgHex(ordinaryDismiss));

    await setup.mockMouse.click(dismissColumn, dismissRow, MouseButtons.LEFT);
    await setup.flush();
    expect(targets).toEqual([{ kind: "toast" }]);
    expect(setup.store.getState().toasts).toEqual([]);
    lines = setup.captureCharFrame().split("\n");
    expect(lines.some((line) => line.includes("Worktrunk failed"))).toBe(false);
  });
});

function collectTextRenderables(renderable: BaseRenderable): TextRenderable[] {
  const collected = renderable instanceof TextRenderable ? [renderable] : [];
  for (const child of renderable.getChildren()) {
    collected.push(...collectTextRenderables(child));
  }
  return collected;
}
