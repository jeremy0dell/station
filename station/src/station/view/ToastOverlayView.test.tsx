import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { nativeStationTheme, StationThemeProvider } from "../../theme/index.js";
import type { ClientNotice } from "@station/dashboard-core/runtime";
import { cellWidth } from "@station/dashboard-core/text";
import { act } from "react";
import { spanAtFrameCell } from "../../terminal/testing/frameProbe.js";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { makeStationTestRuntime } from "../test/support/makeStationTestRuntime.js";
import { DashboardRoot } from "./DashboardRoot.js";
import { StationHoverProvider, StationMouseProvider } from "./stationMouseContext.js";

const NOTICE: ClientNotice = {
  kind: "error",
  message:
    "Worktrunk failed to remove the selected checkout because the main worktree cannot be removed while Station is running there.",
  hint: "Open a different linked checkout, select the session again, and retry after confirming the worktree path and branch.",
  traceId: "trace_worktree_remove_123",
  diagnosticId: "diag_worktree_remove_456",
};
const COPY_TEXT = [
  "needs attention",
  NOTICE.message,
  `${NOTICE.hint} | trace ${NOTICE.traceId} | diagnostic ${NOTICE.diagnosticId}`,
].join("\n");
const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    teardown();
  }
});

describe("ToastOverlayView actions", () => {
  it("keeps a wrapped prompt and notice in disjoint structural regions through resize", async () => {
    const { runtime } = makeStationTestRuntime({ snapshot: manyProjectsSnapshot() });
    runtime.start();
    runtime.actions.handleKey({ input: "R" });
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <DashboardRoot
          state={runtime.state}
          actions={runtime.actions}
          layout={runtime.layout}
          columns={28}
          rows={16}
          onCopyNotice={() => {}}
        />
      </StationThemeProvider>,
      { width: 28, height: 16 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await act(async () => {
      runtime.actions.pushToast(NOTICE);
      await Promise.resolve();
    });
    await setup.flush();

    const prompt = setup.renderer.root.findDescendantById("station-command-prompt");
    const controls = setup.renderer.root.findDescendantById("station-dashboard-controls");
    const toast = setup.renderer.root.findDescendantById("station-toast-surface");
    expect(prompt?.height).toBeGreaterThan(1);
    expect(controls).toBeDefined();
    expect(toast).toBeDefined();
    if (controls === undefined || toast === undefined) {
      throw new Error("dashboard controls and toast surface must render");
    }
    expect(toast.y + toast.height).toBeLessThanOrEqual(controls.y);

    await act(async () => {
      setup.renderer.resize(22, 12);
      await setup.flush();
      await setup.renderOnce();
    });
    expect(toast.y + toast.height).toBeLessThanOrEqual(controls.y);
    expect(setup.captureCharFrame()).toContain("Rename:");

    await act(async () => {
      setup.renderer.resize(22, 5);
      await setup.flush();
      await setup.renderOnce();
    });
    const footer = setup.renderer.root.findDescendantById("station-dashboard-footer");
    expect(footer?.height).toBe(1);
    expect((footer?.y ?? 5) + (footer?.height ?? 0)).toBeLessThanOrEqual(5);
  });

  it("keeps drag selection inert and copies the complete readable notice explicitly", async () => {
    const fixture = await renderNotice();
    const message = cellFor(fixture.frame(), "Worktrunk failed");
    const copy = cellFor(fixture.frame(), "[ copy ]");
    const dismiss = cellFor(fixture.frame(), "[ dismiss ]");

    await fixture.setup.mockMouse.drag(
      message.col,
      message.row,
      message.col + cellWidth("Worktrunk"),
      message.row,
    );
    expect(fixture.setup.renderer.getSelection()?.getSelectedText()).toBe("Worktrunk");
    expect(fixture.targets).toEqual([]);
    expect(fixture.runtime.state.getState().toasts).toHaveLength(1);

    const spans = fixture.setup.captureSpans();
    expect(spanHex(spanAtFrameCell(spans, copy.row, copy.col))).not.toBe(
      spanHex(spanAtFrameCell(spans, dismiss.row, dismiss.col)),
    );

    await act(async () => {
      await fixture.setup.mockMouse.click(copy.col, copy.row, MouseButtons.LEFT);
    });
    await fixture.setup.flush();

    expect(fixture.copied).toEqual([COPY_TEXT]);
    expect(fixture.targets).toEqual([]);
    expect(fixture.runtime.state.getState().toasts).toHaveLength(1);
    expect(fixture.frame()).toContain("[ copied ]");

    await act(async () => {
      fixture.runtime.actions.pushToast({
        ...NOTICE,
        message: "A different operation failed.",
      });
      await Promise.resolve();
    });
    await fixture.setup.flush();
    expect(fixture.frame()).toContain("[ copy ]");
    expect(fixture.frame()).not.toContain("[ copied ]");
  });

  it("keeps hover feedback and dismissal isolated to the dismiss control", async () => {
    const fixture = await renderNotice();
    const dismiss = cellFor(fixture.frame(), "[ dismiss ]");
    const ordinary = spanAtFrameCell(fixture.setup.captureSpans(), dismiss.row, dismiss.col);

    await act(async () => {
      await fixture.setup.mockMouse.moveTo(dismiss.col, dismiss.row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await fixture.setup.flush();
    const hovered = spanAtFrameCell(fixture.setup.captureSpans(), dismiss.row, dismiss.col);
    expect(hovered?.fg).not.toBe(ordinary?.fg);
    expect(hovered?.bg).not.toBe(ordinary?.bg);

    await fixture.setup.mockMouse.click(dismiss.col, dismiss.row, MouseButtons.LEFT);
    await fixture.setup.flush();
    expect(fixture.targets).toEqual([{ kind: "toast" }]);
    expect(fixture.runtime.state.getState().toasts).toEqual([]);
  });

  it("restarts copy feedback when the notice is copied again", async () => {
    const fixture = await renderNotice();
    const firstCopy = cellFor(fixture.frame(), "[ copy ]");

    await act(async () => {
      await fixture.setup.mockMouse.click(firstCopy.col, firstCopy.row, MouseButtons.LEFT);
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const secondCopy = cellFor(fixture.frame(), "[ copied ]");
    await act(async () => {
      await fixture.setup.mockMouse.click(secondCopy.col, secondCopy.row, MouseButtons.LEFT);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    await fixture.setup.flush();

    expect(fixture.copied).toEqual([COPY_TEXT, COPY_TEXT]);
    expect(fixture.frame()).toContain("[ copied ]");
  });
});

async function renderNotice() {
  const { runtime: store } = makeStationTestRuntime({
    snapshot: manyProjectsSnapshot(),
    seedInitialSnapshot: false,
  });
  const targets: StationMouseTarget[] = [];
  const copied: string[] = [];
  store.start();
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationHoverProvider value>
        <StationMouseProvider
          value={(target) => {
            targets.push(target);
            if (target.kind === "toast") {
              store.actions.dismissToasts();
            }
          }}
        >
          <DashboardRoot
            state={store.state}
            actions={store.actions}
            layout={store.layout}
            columns={99}
            rows={25}
            onCopyNotice={(text) => copied.push(text)}
          />
        </StationMouseProvider>
      </StationHoverProvider>
    </StationThemeProvider>,
    { width: 99, height: 25 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  await act(async () => {
    store.actions.pushToast(NOTICE);
    await Promise.resolve();
  });
  await setup.flush();
  return { setup, runtime: store, targets, copied, frame: () => setup.captureCharFrame() };
}

function spanHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.fg === undefined ? undefined : rgbToHex(span.fg);
}

function cellFor(frame: string, label: string): { row: number; col: number } {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes(label));
  const col = lines[row]?.indexOf(label) ?? -1;
  expect(row).toBeGreaterThanOrEqual(0);
  expect(col).toBeGreaterThanOrEqual(0);
  return { row, col };
}
