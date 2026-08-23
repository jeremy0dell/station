import { afterEach, describe, expect, it } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { nativeStationTheme, StationThemeProvider } from "../../../theme/index.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import {
  StationHoverProvider,
  StationMouseProvider,
} from "../stationMouseContext.js";
import { SettingsPanelView } from "./SettingsPanelView.js";

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

async function render(focus: "list" | "detail", size = { width: 80, height: 20 }) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationHoverProvider value>
        <StationMouseProvider value={(target) => targets.push(target)}>
          <SettingsPanelView
            columns={size.width}
            rows={size.height}
            focus={focus}
            title="Settings title"
            compactDetailTitle="Detail title"
            footer="Footer help"
            listHeader="Subject"
            items={[
              {
                id: "general",
                label: "General",
                active: true,
                mouseTarget: { kind: "groupSettingsSection", section: "general" },
              },
              {
                id: "remove",
                label: "Remove",
                active: false,
                danger: true,
                mouseTarget: { kind: "groupSettingsSection", section: "remove" },
              },
            ]}
            renderDetail={({ width, focused }) => (
              <SettingsDetail width={width} focused={focused} />
            )}
          />
        </StationMouseProvider>
      </StationHoverProvider>
    </StationThemeProvider>,
    size,
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  return { setup, targets };
}

function SettingsDetail({ width, focused }: { width: number; focused: boolean }) {
  return <text>{`${focused ? "FOCUSED" : "DETAIL"} ${width}`}</text>;
}

describe("SettingsPanelView", () => {
  it("renders the list, divider, and detail together in split mode", async () => {
    const { setup } = await render("list");
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Settings title");
    expect(frame).toContain("Subject");
    expect(frame).toContain("General");
    expect(frame).toContain("DETAIL");
    expect(frame).toContain("│");
    expect(frame).toContain("Footer help");
  });

  it("renders only the pane owning focus in compact mode", async () => {
    const list = await render("list", { width: 40, height: 12 });
    expect(list.setup.captureCharFrame()).toContain("Settings title");
    expect(list.setup.captureCharFrame()).toContain("General");
    expect(list.setup.captureCharFrame()).not.toContain("FOCUSED");

    const detail = await render("detail", { width: 40, height: 12 });
    expect(detail.setup.captureCharFrame()).toContain("Detail title");
    expect(detail.setup.captureCharFrame()).toContain("FOCUSED");
    expect(detail.setup.captureCharFrame()).not.toContain("General");
  });

  it("emits each feature-owned semantic item target", async () => {
    const { setup, targets } = await render("list");
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Remove"));
    const column = lines[row]?.indexOf("Remove") ?? -1;

    await setup.mockMouse.click(column, row, MouseButtons.LEFT);

    expect(
      targets.some(
        (target) => target.kind === "groupSettingsSection" && target.section === "remove",
      ),
    ).toBe(true);
  });
});
