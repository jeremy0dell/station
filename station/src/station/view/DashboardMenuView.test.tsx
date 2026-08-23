import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { nativeStationTheme, StationThemeProvider } from "../../theme/index.js";
import { DashboardMenuView, type DashboardMenuModel } from "./DashboardMenuView.js";
import { semanticItemRenderableId } from "./layout/scrollViewport.js";

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
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <box id={boundaryId} width={30} height="100%" flexDirection="column">
          <box height={2} flexShrink={0} />
          <box id={anchorRenderableId} height={1} flexShrink={0} />
          <DashboardMenuView
            menu={menu}
            boundaryId={boundaryId}
            anchorRenderableId={anchorRenderableId}
          />
        </box>
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

    await act(async () => {
      setup.renderer.resize(30, 6);
      await setup.flush();
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("▸Action 11");
  });
});
