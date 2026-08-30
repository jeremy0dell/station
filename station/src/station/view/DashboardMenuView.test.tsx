import { afterEach, describe, expect, it } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { MouseButtons } from "@opentui/core/testing";
import { act } from "react";
import { nativeStationTheme, StationThemeProvider } from "../../theme/index.js";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { DashboardMenuView, type DashboardMenuModel } from "./DashboardMenuView.js";
import { semanticItemRenderableId } from "./layout/scroll/scrollViewport.js";
import { StationMouseProvider } from "./stationMouseContext.js";

const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

describe("DashboardMenuView", () => {
  it("mounts every semantic item and follows focus through measured clipping and resize", async () => {
    const boundaryId = "dashboard-menu-test-boundary";
    const anchorRenderableId = "dashboard-menu-test-anchor";
    const menu: DashboardMenuModel = {
      preferredWidth: 24,
      items: Array.from({ length: 12 }, (_, index) => ({
        id: `item-${index}`,
        label: `Action ${index}`,
        focused: index === 11,
        target: { kind: "projectMenuAction", actionId: "quickGroup" as const },
        ...(index > 0 && index % 3 === 0 ? { separatorBefore: true as const } : {}),
      })),
    };
    const pointerTargets: StationMouseTarget[] = [];
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationMouseProvider value={(target) => pointerTargets.push(target)}>
          <box id={boundaryId} width={30} height="100%" flexDirection="column">
            <box height={2} flexShrink={0} />
            <box id={anchorRenderableId} height={1} flexShrink={0} />
            <DashboardMenuView
              menu={menu}
              boundaryId={boundaryId}
              anchorRenderableId={anchorRenderableId}
            />
          </box>
        </StationMouseProvider>
      </StationThemeProvider>,
      { width: 30, height: 8 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await act(async () => {
      await setup.flush();
      await setup.renderOnce();
    });

    expect(setup.captureCharFrame()).toContain("▸Action 11");
    expect(
      setup.renderer.root.findDescendantById(semanticItemRenderableId("item-0")),
    ).toBeDefined();
    expect(
      setup.renderer.root.findDescendantById(semanticItemRenderableId("item-11")),
    ).toBeDefined();
    const focusedItem = setup.renderer.root.findDescendantById(
      semanticItemRenderableId("item-11"),
    );
    if (focusedItem === undefined) throw new Error("focused menu item did not render");
    await setup.mockMouse.click(
      focusedItem.screenX + 2,
      focusedItem.screenY,
      MouseButtons.LEFT,
    );
    expect(pointerTargets.at(-1)).toEqual(menu.items[11]?.target);

    await act(async () => {
      setup.renderer.resize(30, 6);
      await setup.flush();
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("▸Action 11");
  });

  it("routes clipped top and bottom border clicks to the backdrop", async () => {
    const boundaryId = "dashboard-menu-border-boundary";
    const anchorRenderableId = "dashboard-menu-border-anchor";
    const menu: DashboardMenuModel = {
      preferredWidth: 24,
      items: Array.from({ length: 12 }, (_, index) => ({
        id: `border-item-${index}`,
        label: `Border action ${index}`,
        focused: index === 11,
        target: { kind: "projectMenuAction", actionId: "quickGroup" as const },
      })),
    };
    const pointerTargets: StationMouseTarget[] = [];
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationMouseProvider value={(target) => pointerTargets.push(target)}>
          <box id={boundaryId} width={30} height="100%" flexDirection="column">
            <box height={2} flexShrink={0} />
            <box id={anchorRenderableId} height={1} flexShrink={0} />
            <DashboardMenuView
              menu={menu}
              boundaryId={boundaryId}
              anchorRenderableId={anchorRenderableId}
            />
          </box>
        </StationMouseProvider>
      </StationThemeProvider>,
      { width: 30, height: 8 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.flush();

    const menuSurface = setup.renderer.root.findDescendantById("station-dashboard-menu");
    const scrollbox = setup.renderer.root.findDescendantById("station-dashboard-menu-items");
    if (menuSurface === undefined || !(scrollbox instanceof ScrollBoxRenderable)) {
      throw new Error("dashboard menu geometry did not render");
    }
    const x = menuSurface.screenX + 2;
    const top = menuSurface.screenY;
    expect(rawDashboardMenuItemAtPointer(setup, menu, x, top)).toBeDefined();
    await setup.mockMouse.click(x, top, MouseButtons.LEFT);
    expect(pointerTargets).toEqual([{ kind: "sheetBackdrop" }]);

    scrollbox.scrollTop = 0;
    await setup.renderOnce();
    pointerTargets.length = 0;
    const bottom = menuSurface.screenY + menuSurface.height - 1;
    expect(rawDashboardMenuItemAtPointer(setup, menu, x, bottom)).toBeDefined();
    await setup.mockMouse.click(x, bottom, MouseButtons.LEFT);
    expect(pointerTargets).toEqual([{ kind: "sheetBackdrop" }]);
  });
});

function rawDashboardMenuItemAtPointer(
  setup: Awaited<ReturnType<typeof testRender>>,
  menu: DashboardMenuModel,
  x: number,
  y: number,
): DashboardMenuModel["items"][number] | undefined {
  return menu.items.find((item) => {
    const renderable = setup.renderer.root.findDescendantById(semanticItemRenderableId(item.id));
    return (
      renderable !== undefined &&
      x >= renderable.screenX &&
      x < renderable.screenX + renderable.width &&
      y >= renderable.screenY &&
      y < renderable.screenY + renderable.height
    );
  });
}
