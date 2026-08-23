import { afterEach, describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { cellWidth } from "@station/dashboard-core/selectors";
import { spanAtFrameCell } from "../../../terminal/testing/frameProbe.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import {
  nativeStationTheme,
  stationColorSnapshotValue,
  StationThemeProvider,
} from "../../../theme/index.js";
import {
  fit,
  responsiveSheetFooterText,
  responsiveSheetText,
  SheetButtonRow,
  type SheetButtonSpec,
} from "./parts.js";

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

function button(
  id: string,
  key: "y" | "n",
  options: Partial<Pick<SheetButtonSpec, "compactLabel" | "disabled" | "focused">> = {},
): SheetButtonSpec {
  return {
    id,
    label: id,
    shortcut: key.toUpperCase(),
    tone: "primary",
    mouseTarget: {
      kind: "removeWorktreeAction",
      actionId: key === "y" ? "confirm.delete" : "confirm.keep",
    },
    focused: options.focused ?? false,
    disabled: options.disabled ?? false,
    ...(options.compactLabel === undefined ? {} : { compactLabel: options.compactLabel }),
  };
}

async function render(buttons: readonly SheetButtonSpec[], width = 40) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationHoverProvider value>
        <StationMouseProvider value={(target) => targets.push(target)}>
          <SheetButtonRow width={width} buttons={buttons} />
        </StationMouseProvider>
      </StationHoverProvider>
    </StationThemeProvider>,
    { width, height: 2 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  return { setup, targets };
}

describe("SheetButtonRow", () => {
  it("keeps a fitting action natural-width and trailing cells inert", async () => {
    const { setup, targets } = await render([button("Save", "y")]);
    const line = setup.captureCharFrame().split("\n")[0] ?? "";
    expect(line.slice(0, 10)).toBe("  Save (Y)");
    expect(line.slice(10).trim()).toBe("");

    await setup.mockMouse.click(2, 0, MouseButtons.LEFT);
    expect(targets).toEqual([{ kind: "removeWorktreeAction", actionId: "confirm.delete" }]);
    await setup.mockMouse.click(30, 0, MouseButtons.LEFT);
    expect(targets).toHaveLength(1);
  });

  it("keeps fitting action groups compact with inert space after the group", async () => {
    const { setup, targets } = await render([button("Save", "y"), button("Back", "n")]);
    const line = setup.captureCharFrame().split("\n")[0] ?? "";
    const backColumn = line.indexOf("Back");
    expect(backColumn).toBeGreaterThan(10);
    expect(line.slice(backColumn + "Back (N)".length).trim()).toBe("");

    await setup.mockMouse.click(2, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(backColumn, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(35, 0, MouseButtons.LEFT);
    expect(targets).toEqual([
      { kind: "removeWorktreeAction", actionId: "confirm.delete" },
      { kind: "removeWorktreeAction", actionId: "confirm.keep" },
    ]);
  });

  it("uses compact equal-width controls only when the natural group cannot fit", async () => {
    const { setup, targets } = await render([button("Save", "y"), button("Back", "n")], 12);
    expect(setup.captureCharFrame().split("\n")[0]).toBe("  Save  Back");

    await setup.mockMouse.click(2, 0, MouseButtons.LEFT);
    await setup.mockMouse.click(8, 0, MouseButtons.LEFT);
    expect(targets).toEqual([
      { kind: "removeWorktreeAction", actionId: "confirm.delete" },
      { kind: "removeWorktreeAction", actionId: "confirm.keep" },
    ]);
  });

  it("keeps disabled actions inert", async () => {
    const { setup, targets } = await render([button("Save", "y", { disabled: true })]);
    await setup.mockMouse.click(2, 0, MouseButtons.LEFT);
    expect(targets).toEqual([]);
  });

  it("limits hover styling to the natural button boundary", async () => {
    const { setup } = await render([button("Save", "y")]);
    await act(async () => {
      await setup.mockMouse.moveTo(2, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await setup.flush();

    const inside = spanAtFrameCell(setup.captureSpans(), 0, 2);
    const trailing = spanAtFrameCell(setup.captureSpans(), 0, 20);
    expect(inside?.bg === undefined ? undefined : rgbToHex(inside.bg)).toBe(
      stationColorSnapshotValue(nativeStationTheme.action.primary),
    );
    expect(trailing?.bg === undefined ? undefined : rgbToHex(trailing.bg)).not.toBe(
      stationColorSnapshotValue(nativeStationTheme.action.primary),
    );
  });
});

describe("responsive sheet text", () => {
  const variants = {
    expanded: "Expanded copy",
    compact: "Compact",
  } as const;

  it("selects copy from measured available width", () => {
    const expandedWidth = variants.expanded.length;
    expect(responsiveSheetText(expandedWidth, variants)).toBe(variants.expanded);
    const narrowerWidth = expandedWidth - " ".length;
    expect(responsiveSheetText(narrowerWidth, variants)).toBe(variants.compact);
  });

  it("reserves the footer inset before selecting copy", () => {
    const expandedFooter = ` ${variants.expanded}`;
    expect(responsiveSheetFooterText(expandedFooter.length, variants)).toBe(variants.expanded);
    expect(responsiveSheetFooterText(variants.expanded.length, variants)).toBe(variants.compact);
  });
});

describe("sheet terminal-cell fitting", () => {
  it("fits wide and combining graphemes by cells without splitting them", () => {
    expect(fit("界a", 3)).toBe("界a");
    expect(cellWidth(fit("界a", 3))).toBe(3);
    expect(fit("界a", 2)).toBe("界");
    expect(cellWidth(fit("e\u0301", 2))).toBe(2);
    expect(fit("e\u0301", 2)).toBe("e\u0301 ");
  });
});
