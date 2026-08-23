import { describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import {
  nativeStationTheme,
  StationThemeProvider,
  type StationTheme,
} from "../theme/index.js";
import {
  alphaColor,
  indexedColor,
  rgbColor,
  terminalDefaultColor,
} from "../theme/types.js";
import { spanAtFrameCell } from "../terminal/testing/frameProbe.js";
import type { MouseTargetRef } from "../input/router.js";
import type { StationMouseEvent } from "../input/mouse.js";
import type { ContextMenuItem } from "./types.js";
import {
  ContextMenuSurface,
  contextMenuItemRenderableId,
} from "./ContextMenuSurface.js";

const TEST_BOUNDARY_ID = "context-menu-surface-test-boundary";

const ITEMS: readonly ContextMenuItem[] = [
  { id: "pane.splitRight", label: "Split Right", disabled: true, action: { kind: "noop" } },
  { id: "pane.splitBelow", label: "Split Below", disabled: true, action: { kind: "noop" } },
  { id: "pane.close", label: "Close Pane", action: { kind: "closePane", paneId: "pane-a" } },
];

describe("ContextMenuSurface", () => {
  it("renders menu labels inside a bounded surface", async () => {
    const setup = await renderSurface();
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Split Right");
      expect(frame).toContain("Split Below");
      expect(frame).toContain("Close Pane");
      expect(frame.split("\n").find((line) => line.includes("Close Pane"))).toContain(
        "▸Close Pane",
      );
    } finally {
      setup.renderer.destroy();
    }
  });

  it("routes item mouse targets with normalized click events", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderSurface((target, event) => {
      calls.push({ target, event });
      return true;
    });
    try {
      const lines = setup.captureCharFrame().split("\n");
      const closeRow = lines.findIndex((line) => line.includes("Close Pane"));
      const closeColumn = lines[closeRow]?.indexOf("Close Pane") ?? -1;
      await setup.mockMouse.click(closeColumn, closeRow, MouseButtons.LEFT);
      expect(calls).toEqual([
        {
          target: { kind: "contextMenuItem", itemIndex: 2 },
          event: {
            type: "down",
            button: "left",
            rawButton: 0,
            x: 2,
            y: 3,
            modifiers: { shift: false, alt: false, ctrl: false },
          },
        },
      ]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("preserves non-RGB intent through a real menu surface", async () => {
    const indexedSnapshot = rgbColor("#cd3131");
    const theme = {
      ...nativeStationTheme,
      text: {
        ...nativeStationTheme.text,
        menu: terminalDefaultColor("foreground", rgbColor("#d4d4d8")),
      },
      contextMenu: {
        surface: terminalDefaultColor("background", rgbColor("#101316")),
        selected: indexedColor(1, indexedSnapshot),
        border: alphaColor(rgbColor("#336699"), 0.5),
      },
    } as const satisfies StationTheme;
    const setup = await renderSurface(() => true, theme);
    try {
      const spans = setup.captureSpans();
      const border = spanAtFrameCell(spans, 0, 0)?.fg;
      expect(border?.intent).toBe("rgb");
      // OpenTUI composites alpha into the terminal cell while preserving the requested blend.
      expect(border === undefined ? undefined : rgbToHex(border)).toBe("#223d58");

      const inactive = spanAtFrameCell(spans, 1, 1);
      expect(inactive?.bg.intent).toBe("default");

      const selected = spanAtFrameCell(spans, 3, 1);
      expect(selected?.bg.intent).toBe("indexed");
      expect(selected?.bg.slot).toBe(1);
      expect(selected?.bg === undefined ? undefined : rgbToHex(selected.bg)).toBe("#cd3131");
      expect(selected?.fg.intent).toBe("default");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders Group keyboard shortcuts and separators without changing item indices", async () => {
    const calls: MouseTargetRef[] = [];
    const items: readonly ContextMenuItem[] = [
      {
        id: "group.quickSession",
        label: "Quick session",
        shortcut: "Q",
        action: { kind: "noop" },
      },
      {
        id: "group.newSession",
        label: "New session…",
        shortcut: "N",
        action: { kind: "noop" },
      },
      {
        id: "group.openSettings",
        label: "Group settings…",
        shortcut: "S",
        separatorBefore: true,
        action: { kind: "noop" },
      },
      {
        id: "group.remove",
        label: "Remove Group…",
        shortcut: "R",
        separatorBefore: true,
        danger: true,
        action: { kind: "noop" },
      },
    ];
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <box id={TEST_BOUNDARY_ID} width={24} height="100%">
          <ContextMenuSurface
            items={items}
            activeIndex={0}
            anchor={{ x: 0, y: -1 }}
            preferredWidth={22}
            boundaryId={TEST_BOUNDARY_ID}
            dispatchMouse={(target) => {
              calls.push(target);
              return true;
            }}
          />
        </box>
      </StationThemeProvider>,
      { width: 24, height: 9 },
    );
    await setup.flush();
    try {
      const frame = setup.captureCharFrame();
      const spans = setup.captureSpans();
      const lines = frame.split("\n");
      expect(lines[1]).toMatch(/▸Quick session\s+Q/);
      expect(lines[2]).toMatch(/ New session…\s+N/);
      expect(lines[3]).toContain("────────────────────");
      expect(lines[4]).toMatch(/ Group settings…\s+S/);
      expect(lines[5]).toContain("────────────────────");
      expect(lines[6]).toMatch(/ Remove Group…\s+R/);
      expect(lines.filter((line) => line.includes("▸"))).toHaveLength(1);
      expect(spanAtFrameCell(spans, 6, 2)?.fg).not.toEqual(spanAtFrameCell(spans, 1, 2)?.fg);
      const removeRow = lines.findIndex((line) => line.includes("Remove Group…"));
      const removeColumn = lines[removeRow]?.indexOf("Remove Group…") ?? -1;
      await setup.mockMouse.click(removeColumn, removeRow, MouseButtons.LEFT);
      expect(calls.at(-1)).toEqual({ kind: "contextMenuItem", itemIndex: 3 });
    } finally {
      setup.renderer.destroy();
    }
  });

  it("routes item hover targets on mouse move", async () => {
    const calls: Array<{ target: MouseTargetRef; event: StationMouseEvent }> = [];
    const setup = await renderSurface((target, event) => {
      calls.push({ target, event });
      return true;
    });
    try {
      await setup.mockMouse.moveTo(2, 2);
      // Hover over the middle row highlights it (index 1) without selecting.
      expect(calls.at(-1)?.target).toEqual({ kind: "contextMenuItemHover", itemIndex: 1 });
      expect(calls.at(-1)?.event.type).toBe("move");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("maps every painted line of a wrapped action to one semantic pointer target", async () => {
    const calls: MouseTargetRef[] = [];
    const items: readonly ContextMenuItem[] = [
      {
        id: "pane.automation.verbose",
        label: "Run the verbose automation action",
        action: { kind: "noop" },
      },
      { id: "pane.close", label: "Close", action: { kind: "closePane", paneId: "pane-a" } },
    ];
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <box id={TEST_BOUNDARY_ID} width={14} height="100%">
          <ContextMenuSurface
            items={items}
            activeIndex={0}
            anchor={{ x: 0, y: -1 }}
            preferredWidth={14}
            boundaryId={TEST_BOUNDARY_ID}
            dispatchMouse={(target) => {
              calls.push(target);
              return true;
            }}
          />
        </box>
      </StationThemeProvider>,
      { width: 14, height: 8 },
    );
    await setup.flush();
    try {
      const verbose = setup.renderer.root.findDescendantById(
        contextMenuItemRenderableId("pane.automation.verbose"),
      );
      expect(verbose?.height).toBeGreaterThan(1);
      if (verbose === undefined) throw new Error("verbose context action did not render");
      await setup.mockMouse.click(
        verbose.screenX + 2,
        verbose.screenY + 1,
        MouseButtons.LEFT,
      );
      expect(calls.at(-1)).toEqual({ kind: "contextMenuItem", itemIndex: 0 });
    } finally {
      setup.renderer.destroy();
    }
  });

  it("keeps a long semantic action list mounted and follows focus through resize", async () => {
    const items: readonly ContextMenuItem[] = Array.from({ length: 14 }, (_, index) => ({
      id: `pane.automation.action-${index}`,
      label: `Action ${index}`,
      action: { kind: "noop" as const },
      ...(index > 0 && index % 4 === 0 ? { separatorBefore: true as const } : {}),
    }));
    const setup = await testRender(
      <StationThemeProvider theme={nativeStationTheme}>
        <box id={TEST_BOUNDARY_ID} width={24} height="100%">
          <ContextMenuSurface
            items={items}
            activeIndex={13}
            anchor={{ x: 20, y: 7 }}
            preferredWidth={18}
            boundaryId={TEST_BOUNDARY_ID}
            dispatchMouse={() => true}
          />
        </box>
      </StationThemeProvider>,
      { width: 24, height: 8 },
    );
    await setup.flush();
    try {
      expect(setup.captureCharFrame()).toContain("▸Action 13");
      expect(
        setup.renderer.root.findDescendantById(
          contextMenuItemRenderableId("pane.automation.action-0"),
        ),
      ).toBeDefined();
      expect(
        setup.renderer.root.findDescendantById(
          contextMenuItemRenderableId("pane.automation.action-13"),
        ),
      ).toBeDefined();

      setup.renderer.resize(24, 5);
      await setup.flush();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("▸Action 13");
    } finally {
      setup.renderer.destroy();
    }
  });
});

async function renderSurface(
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean = () => true,
  theme: StationTheme = nativeStationTheme,
) {
  const setup = await testRender(
    <StationThemeProvider theme={theme}>
      <box id={TEST_BOUNDARY_ID} width={24} height="100%">
        <ContextMenuSurface
          items={ITEMS}
          activeIndex={2}
          anchor={{ x: 0, y: -1 }}
          preferredWidth={18}
          boundaryId={TEST_BOUNDARY_ID}
          dispatchMouse={dispatchMouse}
        />
      </box>
    </StationThemeProvider>,
    { width: 24, height: 8 },
  );
  await setup.flush();
  return setup;
}
