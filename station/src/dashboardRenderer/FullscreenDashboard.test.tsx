import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { makeStationTestStore } from "../station/test/support/makeStationTestStore.js";
import type { DashboardMouseEffects } from "./dashboardMouse.js";
import { FullscreenDashboard } from "./FullscreenDashboard.js";

const SURFACE = { width: 80, height: 24 };
const TEST_EFFECTS: DashboardMouseEffects = {
  openShell: () => {},
  openUrl: () => {},
};
const teardowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) {
    await teardown();
  }
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

  it("lets modal controls intercept a dashboard row beneath them", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");
    await actOn(async () => {
      fixture.store.getState().handleKey({ input: "H" });
      await setup.flush();
      await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
    });

    expect(fixture.store.getState().screen).toEqual({ name: "help" });
    expect(fixture.store.getState().localRows.pendingStart).toEqual([]);
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

async function render(
  store: ReturnType<typeof makeStationTestStore>["store"],
  size: { width: number; height: number } = SURFACE,
  effects: DashboardMouseEffects = TEST_EFFECTS,
) {
  const setup = await testRender(<FullscreenDashboard store={store} effects={effects} />, size);
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

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 750;
  for (;;) {
    if (assertion()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
