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
import type { TopRowWidgetText } from "@station/dashboard-core";
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
    topRowWidgets?: readonly TopRowWidgetText[];
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

  it("renders widgets in the loading-state header", async () => {
    const setup = await renderDashboard({
      width: 80,
      height: 24,
      connection: { state: "loading", since: Date.now() },
      topRowWidgets: [{ text: "10:42 AM" }],
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("10:42 AM");
    expect(frame).toContain("Loading observer snapshot...");
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
    // Project headers with the disclosure marker and harness suffix.
    expect(frame).toContain("▼ station - 4 worktrees | codex");
    expect(frame).toContain("▼ observer - 2 worktrees | opencode");
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
    const setup = await renderDashboard({ width: 80, height: 24, snapshot: manyProjectsSnapshot() });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[1]");
    // The starting row gets a slot too (it has a focusable terminal), but the
    // empty project renders its zero-count line with no slot cell.
    expect(frame).toContain("0 worktrees");
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
