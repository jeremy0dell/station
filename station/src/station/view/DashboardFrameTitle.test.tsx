import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { spanAtFrameCell } from "../../terminal/testing/frameProbe.js";
import {
  attentionAndFailuresSnapshot,
  manyProjectsSnapshot,
  scenarioState,
} from "../fixtures/scenarios.js";
import type { TopRowWidgetView } from "@station/dashboard-core/widgets/types";
import { makeStationTestStore } from "../test/support/makeStationTestStore.js";
import { DashboardFrameTitle } from "./DashboardFrameTitle.js";
import { STATION_COLORS } from "./theme.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const SIZE = { width: 80, height: 4 };
const FRAME = { left: 0, top: 0, width: 80 };

function spanHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.fg === undefined ? undefined : rgbToHex(span.fg);
}

describe("DashboardFrameTitle", () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  async function renderTitle(input: {
    snapshot?: ReturnType<typeof manyProjectsSnapshot>;
    connection?: ReturnType<typeof scenarioState>["connection"];
    widgets?: readonly TopRowWidgetView[];
  }) {
    const { store } = makeStationTestStore({
      snapshot: input.snapshot ?? null,
      connection: input.connection,
      seedInitialSnapshot: false,
    });
    store.getState().start();
    const setup = await testRender(
      <DashboardFrameTitle
        store={store}
        frame={FRAME}
        topRowWidgets={input.widgets ?? []}
        zIndex={1}
      />,
      SIZE,
    );
    teardowns.push(() => {
      setup.renderer.destroy();
    });
    await setup.renderOnce();
    return setup;
  }

  it("shows the identity, the overview subtitle, and the widget strip as gray chrome", async () => {
    const setup = await renderTitle({
      snapshot: manyProjectsSnapshot(),
      widgets: [
        { id: "time:0", text: "10:42 AM" },
        { id: "moon:1", text: "🌖 waning gibbous", compact: "🌖" },
      ],
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("station · overview");
    expect(frame).toContain("10:42 AM · 🌖 waning gibbous");
    expect(frame).toContain("[+]");

    const lines = frame.split("\n");
    const spans = setup.captureSpans();
    const subtitleCol = lines[0]?.indexOf("· overview") ?? -1;
    expect(spanHex(spanAtFrameCell(spans, 0, subtitleCol))).toBe(STATION_COLORS.gray);
    const stripCol = lines[0]?.indexOf("10:42 AM") ?? -1;
    expect(spanHex(spanAtFrameCell(spans, 0, stripCol))).toBe(STATION_COLORS.gray);
  });

  it("swaps the subtitle to a red needs-you flag when sessions ask", async () => {
    const setup = await renderTitle({ snapshot: attentionAndFailuresSnapshot() });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("station ! 3 need you");
    expect(frame).not.toContain("· overview");

    const lines = frame.split("\n");
    const spans = setup.captureSpans();
    const flagCol = lines[0]?.indexOf("! 3 need you") ?? -1;
    expect(spanHex(spanAtFrameCell(spans, 0, flagCol))).toBe(STATION_COLORS.red);
  });

  it("carries the display-only reconnect status in the strip", async () => {
    const disconnected = scenarioState("disconnected");
    const setup = await renderTitle({
      snapshot: disconnected.snapshot,
      connection: disconnected.connection,
    });
    expect(setup.captureCharFrame()).toContain("observer reconnecting · display-only snapshot");
  });

  it("resolves snapshot widgets against the live snapshot", async () => {
    const setup = await renderTitle({
      snapshot: manyProjectsSnapshot(),
      widgets: [{ id: "fleet:0", text: "", data: "fleet" }],
    });
    expect(setup.captureCharFrame()).toContain("7 agents");
  });
});
