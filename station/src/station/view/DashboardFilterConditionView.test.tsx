import { afterEach, describe, expect, it } from "bun:test";
import {
  type BaseRenderable,
  type BoxRenderable,
  rgbToHex,
  TextRenderable,
} from "@opentui/core";
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
import {
  DashboardFilterConditionView,
  FILTER_CONDITION_PANEL_ID,
} from "./DashboardFilterConditionView.js";
import { semanticItemRenderableId } from "./layout/scrollViewport.js";
import { StationMouseProvider } from "./stationMouseContext.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const teardowns: Array<() => void> = [];
const TEST_BOUNDARY_ID = "filter-condition-test-boundary";

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
  anchorHeight = 0,
) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
      <StationMouseProvider value={(target) => targets.push(target)}>
        <box id={TEST_BOUNDARY_ID} width={50} height="100%" flexDirection="column">
          {anchorHeight === 0 ? null : <box height={anchorHeight} flexShrink={0} />}
          <DashboardFilterConditionView
            screen={screen(conditionEditor, draftConditions)}
            columns={50}
            boundaryId={TEST_BOUNDARY_ID}
          />
        </box>
      </StationMouseProvider>
    </StationThemeProvider>,
    { width: 50, height: 10 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  return { setup, targets };
}

describe("DashboardFilterConditionView", () => {
  it("renders disclosure rows with staged summaries and semantic pointer targets", async () => {
    const { setup, targets } = await renderCondition({
      stage: "field",
      focusedItemId: "status",
    });
    const frame = setup.captureCharFrame();

    expect(frame).toContain("FILTER CONDITIONS");
    expect(frame).toContain("S Status");
    expect(frame).toContain("Working ›");
    expect(frame).toContain("P Project");
    expect(frame).toContain("Any ›");
    const panel = setup.renderer.root.findDescendantById(
      FILTER_CONDITION_PANEL_ID,
    ) as BoxRenderable;
    expect(panel.height).toBeLessThan(setup.renderer.height);
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
      { stage: "field", focusedItemId: "status" },
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
      { stage: "field", focusedItemId: "status" },
      {
        stage: "values",
        field: "status",
        focusedValueId: "working",
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
      focusedValueId: "working",
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

  it("keeps every value mounted and follows semantic focus through clipping", async () => {
    const options = Array.from({ length: 14 }, (_, index) => ({
      id: `project-${index}`,
      label: `Project ${index}`,
    }));
    const { setup } = await renderCondition(
      {
        stage: "values",
        field: "project",
        focusedValueId: "project-13",
        options,
        selectedIds: ["project-13"],
      },
      defaultConditions,
      3,
    );
    await act(async () => {
      await setup.flush();
    });

    const frame = setup.captureCharFrame();
    expect(frame).toContain("▸ e [✓] Project 13");
    expect(frame).toContain("Done (Enter)");
    expect(
      setup.renderer.root.findDescendantById(
        semanticItemRenderableId("value:project:project-0"),
      ),
    ).toBeDefined();
    expect(
      setup.renderer.root.findDescendantById(
        semanticItemRenderableId("value:project:project-13"),
      ),
    ).toBeDefined();
    const panel = setup.renderer.root.findDescendantById(
      FILTER_CONDITION_PANEL_ID,
    ) as BoxRenderable;
    expect(panel.y).toBe(3);
    expect(panel.height).toBeLessThanOrEqual(7);

    await act(async () => {
      setup.renderer.resize(50, 8);
      await setup.flush();
    });
    expect(panel.height).toBeLessThanOrEqual(5);
    expect(setup.captureCharFrame()).toContain("▸ e [✓] Project 13");
    expect(setup.captureCharFrame()).toContain("Done (Enter)");
  });
});

function collectTextRenderables(renderable: BaseRenderable): TextRenderable[] {
  const collected = renderable instanceof TextRenderable ? [renderable] : [];
  for (const child of renderable.getChildren()) {
    collected.push(...collectTextRenderables(child));
  }
  return collected;
}
