import { afterEach, describe, expect, it } from "bun:test";
import { type BaseRenderable, rgbToHex, TextRenderable } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { act } from "react";
import {
  nativeStationTheme,
  StationThemeProvider,
  stationColorSnapshotValue,
} from "../../theme/index.js";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { DashboardFilterConditionView } from "./DashboardFilterConditionView.js";
import { StationMouseProvider } from "./stationMouseContext.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const teardowns: Array<() => void> = [];

afterEach(async () => {
  await act(async () => {
    for (const teardown of teardowns.splice(0)) teardown();
  });
});

type PersistentFilterScreen = Extract<DashboardScreenView, { name: "persistentFilter" }>;

type PersistentFilterConditionEditor = NonNullable<PersistentFilterScreen["conditionEditor"]>;

const defaultConditions: PersistentFilterScreen["draftConditions"] = [
  { field: "status", values: [{ id: "working", label: "Working" }] },
];

function screen(
  conditionEditor: PersistentFilterConditionEditor,
  draftConditions: PersistentFilterScreen["draftConditions"],
): PersistentFilterScreen {
  return {
    name: "persistentFilter",
    draft: { value: "", cursor: 0 },
    draftConditions,
    conditionEditor,
  };
}

async function renderCondition(
  conditionEditor: PersistentFilterConditionEditor,
  draftConditions: PersistentFilterScreen["draftConditions"] = defaultConditions,
) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationMouseProvider value={(target) => targets.push(target)}>
        <DashboardFilterConditionView
          screen={screen(conditionEditor, draftConditions)}
          columns={50}
          availableRows={9}
          top={0}
        />
      </StationMouseProvider>
    </StationThemeProvider>,
    { width: 50, height: 10 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await act(async () => setup.renderOnce());
  return { setup, targets };
}

describe("DashboardFilterConditionView", () => {
  it("renders disclosure rows with staged summaries and semantic pointer targets", async () => {
    const { setup, targets } = await renderCondition({ stage: "field", cursor: 0 });
    const frame = setup.captureCharFrame();

    expect(frame).toContain("FILTER CONDITIONS");
    expect(frame).toContain("S Status");
    expect(frame).toContain("Working ›");
    expect(frame).toContain("P Project");
    expect(frame).toContain("Any ›");
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const fieldColors = ["Status", "Project", "Agent"].map((label) => {
      const span = spans.find((candidate) => candidate.text.includes(label));
      return span === undefined ? undefined : rgbToHex(span.fg);
    });
    expect(fieldColors.every((color) => color !== undefined)).toBe(true);
    expect(new Set(fieldColors).size).toBe(1);
    const hotkeyColors = ["S", "P", "A"].map((key) => {
      const span = spans.find((candidate) => candidate.text.trim() === key);
      return span?.fg === undefined ? undefined : rgbToHex(span.fg);
    });
    expect(hotkeyColors).toEqual(
      Array.from({ length: 3 }, () => stationColorSnapshotValue(nativeStationTheme.action.warning)),
    );

    expect(frame).toContain("Apply filter (F)");

    await act(async () => {
      await setup.mockMouse.click(4, 2, MouseButtons.LEFT);
      await setup.mockMouse.click(8, 6, MouseButtons.LEFT);
    });
    expect(targets).toEqual([
      { kind: "persistentFilterConditionField", field: "status" },
      { kind: "persistentFilterConditionAction", actionId: "applyFilter" },
    ]);
  });

  it("keeps a first-value count when it fits and falls back to the count when it does not", async () => {
    const { setup } = await renderCondition(
      { stage: "field", cursor: 0 },
      [
        {
          field: "status",
          values: [
            { id: "needs_attention", label: "Needs attention" },
            { id: "stuck", label: "Stuck" },
          ],
        },
        {
          field: "project",
          values: [
            { id: "extraordinarily-long-project", label: "Extraordinarily long project" },
            { id: "station", label: "Station" },
          ],
        },
      ],
    );
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Needs attention +1 ›");
    expect(frame).toMatch(/P Project +2 ›/);
  });

  it("keeps builder and value-menu text out of OpenTUI selection", async () => {
    const editors: PersistentFilterConditionEditor[] = [
      { stage: "field", cursor: 0 },
      {
        stage: "values",
        field: "status",
        cursor: 0,
        options: [{ id: "working", label: "Working" }],
        selectedIds: [],
      },
    ];

    for (const editor of editors) {
      const { setup } = await renderCondition(editor);
      const textRenderables = collectTextRenderables(setup.renderer.root);
      expect(textRenderables.length).toBeGreaterThan(0);
      expect(textRenderables.every((renderable) => renderable.selectable === false)).toBe(true);
    }
  });

  it("renders status values with checked and cursor affordances", async () => {
    const { setup, targets } = await renderCondition({
      stage: "values",
      field: "status",
      cursor: 2,
      options: [
        { id: "needs_attention", label: "Needs attention" },
        { id: "stuck", label: "Stuck" },
        { id: "working", label: "Working" },
      ],
      selectedIds: ["working"],
    });
    const frame = setup.captureCharFrame();

    expect(frame).toContain("STATUS CONDITION");
    expect(frame).toContain("▸ 3 [✓] Working");
    expect(frame).toContain("[←]");
    expect(frame).toContain("[×]");
    expect(frame).toContain("Done (Enter)");

    await act(async () => {
      await setup.mockMouse.click(6, 4, MouseButtons.LEFT);
      await setup.mockMouse.click(1, 1, MouseButtons.LEFT);
      await setup.mockMouse.click(6, 5, MouseButtons.LEFT);
      await setup.mockMouse.click(30, 1, MouseButtons.LEFT);
    });
    expect(targets).toEqual([
      {
        kind: "persistentFilterConditionValue",
        field: "status",
        valueId: "working",
      },
      { kind: "persistentFilterConditionAction", actionId: "back" },
      { kind: "persistentFilterConditionAction", actionId: "done" },
      { kind: "persistentFilterConditionAction", actionId: "close" },
    ]);
  });
});

function collectTextRenderables(renderable: BaseRenderable): TextRenderable[] {
  const collected = renderable instanceof TextRenderable ? [renderable] : [];
  for (const child of renderable.getChildren()) {
    collected.push(...collectTextRenderables(child));
  }
  return collected;
}
