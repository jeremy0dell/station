import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, type Dispatch, type SetStateAction, useState } from "react";
import { nativeStationTheme, StationThemeProvider } from "../../../theme/index.js";
import { semanticItemRenderableId } from "../layout/scroll/scrollViewport.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import { SheetChoiceLine, SheetFooter, SheetLine } from "./parts.js";

const teardowns: Array<() => void> = [];
afterEach(async () => {
  await act(async () => {
    for (const teardown of teardowns.splice(0)) teardown();
  });
});

describe("BottomSheetFrameView", () => {
  it("uses one compact preferred frame while the semantic body absorbs spare content", async () => {
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationHoverProvider value>
          <StationMouseProvider value={() => {}}>
            <BottomSheetFrameView columns={80} rows={40} title="Compact sheet">
              <SheetLine width={78}>Short content</SheetLine>
            </BottomSheetFrameView>
          </StationMouseProvider>
        </StationHoverProvider>
      </StationThemeProvider>,
      { width: 80, height: 40 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();

    const sheet = setup.renderer.root.findDescendantById("station-bottom-sheet");
    expect(sheet?.height).toBe(12);
    expect(sheet?.y).toBe(28);
  });

  it("keeps semantic focus visible when mixed-height content above it grows and the terminal shrinks", async () => {
    let setExpanded: Dispatch<SetStateAction<boolean>> | undefined;

    function MixedHeightSheet() {
      const [expanded, updateExpanded] = useState(false);
      setExpanded = updateExpanded;
      return (
        <BottomSheetFrameView
          columns={48}
          rows={9}
          title="Semantic picker"
          bodyItemIds={["details", "target"]}
          followedBodyItemId="target"
          footer={<SheetFooter width={46}>Footer remains pinned</SheetFooter>}
        >
          <box id={semanticItemRenderableId("details")} flexDirection="column">
            <SheetLine width={46}>Variable details</SheetLine>
            {expanded ? (
              <>
                <SheetLine width={46}>Detail two</SheetLine>
                <SheetLine width={46}>Detail three</SheetLine>
                <SheetLine width={46}>Detail four</SheetLine>
                <SheetLine width={46}>Detail five</SheetLine>
              </>
            ) : null}
          </box>
          <SheetChoiceLine
            choiceKey="T"
            label="Semantic target"
            detail=""
            width={46}
            selected
            itemId="target"
          />
        </BottomSheetFrameView>
      );
    }

    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <StationHoverProvider value>
          <StationMouseProvider value={() => {}}>
            <MixedHeightSheet />
          </StationMouseProvider>
        </StationHoverProvider>
      </StationThemeProvider>,
      { width: 48, height: 9 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();
    await setup.flush();

    expect(
      setup.renderer.root.findDescendantById(semanticItemRenderableId("details"))?.height,
    ).toBe(1);
    expect(setup.captureCharFrame()).toContain("▸ T Semantic target");

    await act(async () => setExpanded?.(true));
    await setup.flush();
    expect(
      setup.renderer.root.findDescendantById(semanticItemRenderableId("details"))?.height,
    ).toBe(5);
    expect(setup.captureCharFrame()).toContain("▸ T Semantic target");
    expect(setup.captureCharFrame()).toContain("Footer remains pinned");

    await act(async () => setup.renderer.resize(48, 6));
    await setup.renderOnce();
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("▸ T Semantic target");
    expect(setup.captureCharFrame()).toContain("Footer remains pinned");
  });
});
