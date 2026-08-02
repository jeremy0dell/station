import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { TuiWidgetConfig } from "@station/dashboard-core/widgets/types";
import { act } from "react";
import { makeStationTestStore } from "../station/test/support/makeStationTestStore.js";
import { nativeStationTheme, stationRgbValue } from "../theme/index.js";
import { frameChar, spanAtFrameCell } from "../terminal/testing/frameProbe.js";
import type { DashboardRendererEffects } from "./dashboardEffects.js";
import { StandaloneDashboardApp } from "./StandaloneDashboardApp.js";

const SURFACE = { width: 80, height: 24 };
const WIDGET_SURFACE = { width: 99, height: 25 };
const TEST_EFFECTS: DashboardRendererEffects = {
  openShell: () => {},
  openUrl: () => {},
};
const teardowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) {
    await teardown();
  }
});

describe("FullscreenDashboard surface ownership", () => {
  it("uses terminal-default background intent for its canvas and title chrome", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);

    expectTerminalDefaultBackground(setup, "station · overview");
    const bottomRight = spanAtFrameCell(
      setup.captureSpans(),
      SURFACE.height - 1,
      SURFACE.width - 1,
    );
    expect(bottomRight?.bg.intent).toBe("default");
  });

  for (const testCase of [
    { name: "prompt", keys: ["R"], needle: "Rename:" },
    { name: "bottom sheet", keys: ["C"], needle: "Collapse Project" },
    { name: "Help overlay", keys: ["H"], needle: "station help" },
    { name: "widget settings", keys: ["W"], needle: "saved to config.toml" },
    { name: "project settings", keys: ["P", "1"], needle: "Project settings" },
  ] as const) {
    it(`uses terminal-default background intent for the ${testCase.name}`, async () => {
      const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
      const setup = await render(fixture.store);

      await actOn(async () => {
        for (const input of testCase.keys) {
          fixture.store.getState().handleKey({ input });
        }
        await setup.flush();
      });

      expectTerminalDefaultBackground(setup, testCase.needle);
    });
  }

  it("uses terminal-default background intent for dashboard toasts", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);

    await actOn(async () => {
      fixture.store.getState().pushToast({
        kind: "error",
        message: "Surface ownership notice",
      });
      await setup.flush();
    });

    expectTerminalDefaultBackground(setup, "Surface ownership notice");
  });

  it("obscures dashboard cells with an opaque default background and restores them", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const before = setup.captureCharFrame();

    await actOn(async () => {
      fixture.store.getState().handleKey({ input: "H" });
      await setup.flush();
    });

    const after = setup.captureCharFrame();
    const obscured = findObscuredHelpCell(before, after);
    const span = spanAtFrameCell(setup.captureSpans(), obscured.row, obscured.col);
    expect(frameChar(after, obscured.row, obscured.col)).toBe(" ");
    expect(span?.bg.intent).toBe("default");

    await actOn(async () => {
      fixture.store.getState().handleKey({ input: "Q" });
      await setup.flush();
    });

    expect(frameChar(setup.captureCharFrame(), obscured.row, obscured.col)).toBe(
      obscured.original,
    );
  });
});

describe("FullscreenDashboard mouse composition", () => {
  it("routes a row click into the observer-backed dashboard command flow", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await actOn(async () => {
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
      await waitFor(() =>
        fixture.service.dispatched.some(
          (command) =>
            command.type === "session.startAgent" &&
            command.payload.worktreeId === "wt_station_none",
        ),
      );
    });

    expect(fixture.service.waitedForCommandIds).toEqual(["cmd_tui_1"]);
  });

  it("collapses a project once for a complete primary down/up click", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const header = cellFor(setup.captureCharFrame(), "▼ station");

    await actOn(() => setup.mockMouse.click(header.col, header.row, MouseButtons.LEFT));

    expect([...fixture.store.getState().collapsedProjectIds]).toEqual(["station"]);
  });

  it("does not activate a dashboard row when the same click dismisses a bounded screen", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const frame = setup.captureCharFrame();
    const row = cellFor(frame, "docs-cleanup");
    const titleAction = cellFor(frame, "[+]");
    await actOn(async () => {
      fixture.store.getState().handleKey({ input: "H" });
      await setup.flush();
    });
    await actOn(async () => {
      await setup.mockMouse.moveTo(row.col, row.row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), row.row, SURFACE.width - 2))).not.toBe(
      stationRgbValue(nativeStationTheme.interaction.hover),
    );

    await actOn(async () => {
      await setup.mockMouse.moveTo(titleAction.col, titleAction.row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    expect(spanHex(spanAtFrameCell(setup.captureSpans(), titleAction.row, titleAction.col))).toBe(
      stationRgbValue(nativeStationTheme.text.muted),
    );

    await actOn(async () => {
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
    });

    expect(fixture.store.getState().screen).toEqual({ name: "dashboard" });
    expect(fixture.store.getState().localRows.pendingStart).toEqual([]);
  });

  it("dismisses a bounded screen from the obscured title row", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const titleAction = cellFor(setup.captureCharFrame(), "[+]");
    await actOn(async () => {
      fixture.store.getState().handleKey({ input: "H" });
      await setup.flush();
    });

    await actOn(() =>
      setup.mockMouse.click(titleAction.col, titleAction.row, MouseButtons.LEFT),
    );

    expect(fixture.store.getState().screen).toEqual({ name: "dashboard" });
    expect(fixture.store.getState().localRows.pendingStart).toEqual([]);
  });

  it("dismisses outside a bounded screen while its inner surface still consumes clicks", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    await actOn(async () => {
      fixture.store.getState().handleKey({ input: "H" });
      await setup.flush();
    });
    const help = cellFor(setup.captureCharFrame(), "station help");

    await actOn(() => setup.mockMouse.click(help.col, help.row, MouseButtons.LEFT));
    expect(fixture.store.getState().screen).toEqual({ name: "help" });

    await actOn(() => setup.mockMouse.click(0, 0, MouseButtons.LEFT));
    expect(fixture.store.getState().screen).toEqual({ name: "dashboard" });
  });

  it("keeps controls inside a bounded screen interactive", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    await actOn(async () => {
      fixture.store.getState().handleKey({ input: "W" });
      await setup.flush();
    });
    const addWidget = cellFor(setup.captureCharFrame(), "[ + add widget ]");

    await actOn(async () => {
      await setup.mockMouse.moveTo(addWidget.col, addWidget.row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), addWidget.row, addWidget.col))).toBe(
      stationRgbValue(nativeStationTheme.interaction.hover),
    );

    await actOn(() => setup.mockMouse.click(addWidget.col, addWidget.row, MouseButtons.LEFT));

    expect(fixture.store.getState().screen).toMatchObject({
      name: "widgetSettings",
      focus: "picker",
    });
  });

  it("omits click-away interception while choose-row screens select dashboard rows", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    await actOn(async () => {
      fixture.store.getState().handleKey({ input: "X" });
      await setup.flush();
    });
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await actOn(async () => {
      await setup.mockMouse.moveTo(row.col, row.row);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    expect(spanBgHex(spanAtFrameCell(setup.captureSpans(), row.row, SURFACE.width - 2))).toBe(
      stationRgbValue(nativeStationTheme.interaction.hover),
    );

    await actOn(() => setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT));

    expect(fixture.store.getState().screen).toMatchObject({
      name: "removeWorktree",
      step: "confirm",
      rowId: "ses_wt_station_none",
    });
  });

  it("routes rendered Remove actions without leaking to the dashboard", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");
    await actOn(async () => {
      fixture.store.getState().handleKey({ input: "X" });
      await setup.flush();
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
      await setup.flush();
    });
    const keep = cellFor(setup.captureCharFrame(), "Keep session");

    await actOn(() => setup.mockMouse.click(keep.col, keep.row, MouseButtons.LEFT));

    expect(fixture.store.getState().screen).toEqual({ name: "dashboard" });
    expect(fixture.store.getState().localRows.pendingRemove).toEqual([]);
  });

  it("routes rendered Fork field clicks without submitting", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");
    await actOn(async () => {
      fixture.store.getState().handleKey({ input: "F" });
      await setup.flush();
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
      await setup.flush();
    });
    const copy = cellFor(setup.captureCharFrame(), "Copy");

    await actOn(() => setup.mockMouse.click(copy.col, copy.row, MouseButtons.LEFT));
    expect(fixture.store.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      focus: "copyDirty",
      copyDirty: false,
    });
    const name = cellFor(setup.captureCharFrame(), "Name");

    await actOn(() => setup.mockMouse.click(name.col, name.row, MouseButtons.LEFT));
    expect(fixture.store.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      focus: "name",
      copyDirty: false,
    });
  });

  it("scrolls when the wheel is used over a child row", async () => {
    const fixture = makeStationTestStore({ terminalRows: 12 });
    const setup = await render(fixture.store, { width: 80, height: 12 });
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await actOn(() => setup.mockMouse.scroll(row.col, row.row, "down"));

    expect(fixture.store.getState().scrollOffset).toBe(1);
  });

  it("renders and routes the same project actions as native Station", async () => {
    const size = { width: 120, height: 40 };
    const fixture = makeStationTestStore({ terminalRows: size.height });
    const openedShells: string[] = [];
    const setup = await render(fixture.store, size, {
      openShell: ({ cwd }) => openedShells.push(cwd),
      openUrl: () => {},
    });
    const frame = setup.captureCharFrame();

    expect(frame).toContain("▼ station");
    expect(frame).toContain("no sessions yet");
    expect(frame).toContain("[shell]");
    expect(frame).toContain("[quick session]");
    expect(frame).toContain("[▾]");
    expect(frame).toContain("[ + add session ]");

    const shell = cellFor(frame, "[shell]");
    const quickSession = cellFor(frame, "[quick session]");
    const agentPicker = cellFor(frame, "[▾]");
    await actOn(async () => {
      await setup.mockMouse.click(shell.col, shell.row, MouseButtons.LEFT);
      await setup.mockMouse.click(quickSession.col, quickSession.row, MouseButtons.LEFT);
      await waitFor(() =>
        fixture.service.dispatched.some((command) => command.type === "session.create"),
      );
      await setup.mockMouse.click(agentPicker.col, agentPicker.row, MouseButtons.LEFT);
    });

    expect(openedShells).toEqual(["/Users/example/Developer/station"]);
    expect(fixture.store.getState().screen).toMatchObject({
      name: "projectDefaultAgent",
      projectId: "station",
    });
  });

  it("routes the empty-project add-session button and pull-request links", async () => {
    const size = { width: 120, height: 40 };
    const fixture = makeStationTestStore({ terminalRows: size.height });
    const openedUrls: string[] = [];
    const setup = await render(fixture.store, size, {
      openShell: () => {},
      openUrl: (url) => openedUrls.push(url),
    });
    const frame = setup.captureCharFrame();
    const addSession = cellFor(frame, "[ + add session ]");
    const pullRequest = cellFor(frame, "#73");

    await actOn(async () => {
      await setup.mockMouse.click(addSession.col, addSession.row, MouseButtons.LEFT);
      await waitFor(() =>
        fixture.service.dispatched.some((command) => command.type === "session.create"),
      );
      await setup.mockMouse.click(pullRequest.col, pullRequest.row, MouseButtons.LEFT);
    });

    expect(openedUrls).toEqual(["https://github.com/example/station/pull/73"]);
  });

  it("keeps the dashboard open with its existing toast when a clicked command is rejected", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    fixture.service.nextReceipt = {
      commandId: "cmd_tui_rejected",
      accepted: false,
      status: "rejected",
      error: {
        tag: "CommandDispatchError",
        code: "TEST_REJECTED",
        message: "The test observer rejected this command.",
      },
    };
    const setup = await render(fixture.store);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await actOn(async () => {
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
      await waitFor(() =>
        fixture.store
          .getState()
          .toasts.some(
            (entry) => entry.toast.message === "The test observer rejected this command.",
          ),
      );
    });
    await setup.flush();

    expect(fixture.store.getState().screen).toEqual({ name: "dashboard" });
    expect(setup.captureCharFrame()).toContain("The test observer rejected this command.");
  });
});

describe("FullscreenDashboard configured widgets", () => {
  async function renderWidgets(widgets: readonly TuiWidgetConfig[]) {
    const fixture = makeStationTestStore({ terminalRows: WIDGET_SURFACE.height });
    fixture.store.setState({ widgets });
    const setup = await render(fixture.store, WIDGET_SURFACE);
    return { setup, store: fixture.store };
  }

  it("renders resolved configured widgets in the standalone title row at 99x25", async () => {
    const { setup } = await renderWidgets([{ type: "fleet" }, { type: "prs" }]);

    const titleRow = setup.captureCharFrame().split("\n")[0] ?? "";
    expect(titleRow).toContain("station · overview");
    expect(titleRow).toContain("7 agents · 7 open PRs");
    expect(titleRow).toContain("[+]");
  });

  it("shows the configured definitions in widget settings", async () => {
    const { setup, store } = await renderWidgets([{ type: "fleet" }, { type: "prs" }]);

    await actOn(async () => {
      store.getState().handleKey({ input: "W" });
      await setup.flush();
    });

    const frame = setup.captureCharFrame();
    expect(frame).toContain("[on ] fleet");
    expect(frame).toContain("[on ] open PRs");
    expect(frame).not.toContain("no widgets yet");
  });

  it("keeps the default title stable without fabricating widget values", async () => {
    const { setup, store } = await renderWidgets([]);

    const titleRow = setup.captureCharFrame().split("\n")[0] ?? "";
    expect(titleRow).toContain("station · overview");
    expect(titleRow).toContain("[+]");
    expect(titleRow).not.toContain("agents");
    expect(titleRow).not.toContain("open PR");

    await actOn(async () => {
      store.getState().handleKey({ input: "W" });
      await setup.flush();
    });
    expect(setup.captureCharFrame()).toContain("no widgets yet");
  });
});

async function render(
  store: ReturnType<typeof makeStationTestStore>["store"],
  size: { width: number; height: number } = SURFACE,
  effects: DashboardRendererEffects = TEST_EFFECTS,
) {
  const setup = await testRender(
    <StandaloneDashboardApp store={store} effects={effects} onCopyNotice={() => {}} />,
    size,
  );
  await setup.flush();
  teardowns.push(() =>
    actOn(async () => {
      setup.renderer.destroy();
      await Promise.resolve();
    }),
  );
  return setup;
}

async function actOn(action: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await action();
  });
}

function cellFor(frame: string, needle: string): { col: number; row: number } {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes(needle));
  const col = row < 0 ? -1 : (lines[row]?.indexOf(needle) ?? -1);
  if (row < 0 || col < 0) {
    throw new Error(`Could not find ${JSON.stringify(needle)} in frame:\n${frame}`);
  }
  return { col, row };
}

function findObscuredHelpCell(
  before: string,
  after: string,
): { row: number; col: number; original: string } {
  const lines = after.split("\n");
  const top = lines.findIndex((line) => line.includes("╭") && line.includes("╮"));
  const topCells = [...(lines[top] ?? "")];
  const left = topCells.indexOf("╭");
  const right = topCells.lastIndexOf("╮");
  const bottom = lines.findIndex(
    (line, row) => row > top && frameChar(line, 0, left) === "╰",
  );
  if (top < 0 || left < 0 || right <= left || bottom <= top) {
    throw new Error(`Could not locate Help bounds in frame:\n${after}`);
  }

  for (let row = top + 1; row < bottom; row += 1) {
    for (let col = left + 1; col < right; col += 1) {
      const original = frameChar(before, row, col);
      if (/^[A-Za-z0-9]$/u.test(original) && frameChar(after, row, col) === " ") {
        return { row, col, original };
      }
    }
  }
  throw new Error(`Help did not obscure a stable dashboard character:\n${after}`);
}

function spanHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.fg === undefined ? undefined : rgbToHex(span.fg);
}

function spanBgHex(span: ReturnType<typeof spanAtFrameCell>): string | undefined {
  return span?.bg === undefined ? undefined : rgbToHex(span.bg);
}

function expectTerminalDefaultBackground(
  setup: Awaited<ReturnType<typeof testRender>>,
  needle: string,
): void {
  const cell = cellFor(setup.captureCharFrame(), needle);
  const span = spanAtFrameCell(setup.captureSpans(), cell.row, cell.col);
  expect(span?.bg.intent).toBe("default");
  expect(spanBgHex(span)).toBe(stationRgbValue(nativeStationTheme.text.inverse));
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 750;
  for (;;) {
    if (assertion()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
