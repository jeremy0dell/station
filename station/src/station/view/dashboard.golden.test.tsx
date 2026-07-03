// Golden frames: every scenario at every surface size, captured immediately
// after first render (before the 120ms throbber tick) so the working-row
// throbber shows its first braille frame (⠋) deterministically.
import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex, TextAttributes } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { StationClientConnectionState } from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import { spanAtFrameCell } from "../../terminal/testing/frameProbe.js";
import {
  attentionAndFailuresSnapshot,
  manyProjectsSnapshot,
  noProjectsSnapshot,
  scenarioState,
} from "../fixtures/scenarios.js";
import { makeStationTestStore } from "../test/support/makeStationTestStore.js";
import type { StationMouseTarget } from "../input/stationMouse.js";
import type { TopRowWidgetView } from "@station/dashboard-core/widgets/types";
import { DashboardRoot } from "./DashboardRoot.js";
import { STATION_COLORS } from "./theme.js";
import { StationMouseProvider } from "./stationMouseContext.js";

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

type RenderedDashboard = Awaited<ReturnType<typeof testRender>>;

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
    topRowWidgets?: readonly TopRowWidgetView[];
    dispatchMouse?: (target: StationMouseTarget) => void;
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
        {...(input.topRowWidgets === undefined ? {} : { topRowWidgets: input.topRowWidgets })}
      />
    );
    const setup = await testRender(
      input.dispatchMouse === undefined ? (
        dashboard
      ) : (
        <StationMouseProvider value={(target) => input.dispatchMouse?.(target)}>
          {dashboard}
        </StationMouseProvider>
      ),
      { width: input.width, height: input.height },
    );
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();
    return setup;
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

  it("renders widgets in the loading-state header as gray chrome", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      connection: { state: "loading", since: Date.now() },
      topRowWidgets: [{ id: "time:0", text: "10:42 AM" }],
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("10:42 AM");
    expect(frame).toContain("Loading observer snapshot...");

    const lines = frame.split("\n");
    const headerRow = lines.findIndex((line) => line.includes("10:42 AM"));
    const widgetCol = lines[headerRow]?.indexOf("10:42 AM") ?? -1;
    expect(widgetCol).toBeGreaterThan(0);
    const spans = setup.captureSpans();
    expect(spanHex(spanAtFrameCell(spans, headerRow, widgetCol))).toBe(STATION_COLORS.gray);
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

  it("shows the display-only reconnect status in the header", async () => {
    const disconnected = scenarioState("disconnected");
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      snapshot: disconnected.snapshot,
      connection: disconnected.connection,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("observer reconnecting · display-only snapshot");
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

  it("paints hovered worktree rows through the trailing action column", async () => {
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
});
