import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { makeStationTestStore } from "../station/test/support/makeStationTestStore.js";
import { FullscreenDashboard } from "./FullscreenDashboard.js";

const SURFACE = { width: 80, height: 24 };
const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    teardown();
  }
});

describe("FullscreenDashboard mouse composition", () => {
  it("routes a row click into the observer-backed dashboard command flow", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
    await waitFor(() =>
      fixture.service.dispatched.some(
        (command) =>
          command.type === "session.startAgent" && command.payload.worktreeId === "wt_station_none",
      ),
    );

    expect(fixture.service.waitedForCommandIds).toEqual(["cmd_tui_1"]);
  });

  it("collapses a project once for a complete primary down/up click", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const header = cellFor(setup.captureCharFrame(), "▼ station");

    await setup.mockMouse.click(header.col, header.row, MouseButtons.LEFT);

    expect([...fixture.store.getState().collapsedProjectIds]).toEqual(["station"]);
  });

  it("lets modal controls intercept a dashboard row beneath them", async () => {
    const fixture = makeStationTestStore({ terminalRows: SURFACE.height });
    const setup = await render(fixture.store);
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");
    fixture.store.getState().handleKey({ input: "H" });
    await setup.flush();

    await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);

    expect(fixture.store.getState().screen).toEqual({ name: "help" });
    expect(fixture.store.getState().localRows.pendingStart).toEqual([]);
  });

  it("scrolls when the wheel is used over a child row", async () => {
    const fixture = makeStationTestStore({ terminalRows: 12 });
    const setup = await render(fixture.store, { width: 80, height: 12 });
    const row = cellFor(setup.captureCharFrame(), "docs-cleanup");

    await setup.mockMouse.scroll(row.col, row.row, "down");

    expect(fixture.store.getState().scrollOffset).toBe(1);
  });

  it("does not render Station-native project actions", async () => {
    const size = { width: 80, height: 40 };
    const fixture = makeStationTestStore({ terminalRows: size.height });
    const setup = await render(fixture.store, size);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("▼ station");
    expect(frame).toContain("no sessions yet");
    expect(frame).not.toContain("[shell]");
    expect(frame).not.toContain("[sh]");
    expect(frame).not.toContain("[quick session]");
    expect(frame).not.toContain("[qs]");
    expect(frame).not.toContain("[▾]");
    expect(frame).not.toContain("[ + add session ]");
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

    await setup.mockMouse.click(row.col, row.row, MouseButtons.LEFT);
    await waitFor(() =>
      fixture.store
        .getState()
        .toasts.some((entry) => entry.toast.message === "The test observer rejected this command."),
    );
    await setup.flush();

    expect(fixture.store.getState().screen).toEqual({ name: "dashboard" });
    expect(setup.captureCharFrame()).toContain("The test observer rejected this command.");
  });
});

async function render(
  store: ReturnType<typeof makeStationTestStore>["store"],
  size: { width: number; height: number } = SURFACE,
) {
  const setup = await testRender(<FullscreenDashboard store={store} />, size);
  await setup.flush();
  teardowns.push(() => setup.renderer.destroy());
  return setup;
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
