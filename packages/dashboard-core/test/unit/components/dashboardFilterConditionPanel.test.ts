import { describe, expect, it } from "vitest";
import { dashboardFilterConditionPanelModel } from "../../../src/components/Dashboard/filterConditionPanel.js";
import type { TuiScreen } from "../../../src/state/types.js";

function filterScreen(
  conditionEditor: Extract<TuiScreen, { name: "persistentFilter" }>["conditionEditor"],
): Extract<TuiScreen, { name: "persistentFilter" }> {
  return {
    name: "persistentFilter",
    draft: { value: "", cursor: 0 },
    draftConditions: [
      {
        field: "status",
        values: [
          { id: "working", label: "Working" },
          { id: "idle", label: "Idle" },
        ],
      },
    ],
    ...(conditionEditor === undefined ? {} : { conditionEditor }),
  };
}

describe("dashboard filter condition panel", () => {
  it("renders the fixed field chooser with direct keys and staged summaries", () => {
    const model = dashboardFilterConditionPanelModel({
      screen: filterScreen({ stage: "field", focusedItemId: "project" }),
    });

    expect(model).toMatchObject({
      stage: "field",
      title: "FILTER CONDITIONS",
      actions: [
        { id: "close", label: "×", placement: "header" },
        {
          id: "applyFilter",
          label: "Apply filter",
          shortcut: "F",
          placement: "footer",
          focused: false,
        },
      ],
      rows: [
        {
          kind: "field",
          marker: " ",
          key: "S",
          label: "Status",
          summary: "Working +1",
          selectionCount: 2,
          field: "status",
        },
        {
          kind: "field",
          marker: "▸",
          key: "P",
          label: "Project",
          summary: "Any",
          selectionCount: 0,
          field: "project",
        },
        {
          kind: "field",
          marker: " ",
          key: "A",
          label: "Agent",
          summary: "Any",
          selectionCount: 0,
          field: "agent",
        },
      ],
    });
  });

  it("focuses the final apply action after the three condition fields", () => {
    const model = dashboardFilterConditionPanelModel({
      screen: filterScreen({ stage: "field", focusedItemId: "applyFilter" }),
    });

    expect(model?.rows.every((row) => row.marker === " ")).toBe(true);
    expect(model?.actions).toContainEqual({
      id: "applyFilter",
      label: "Apply filter",
      shortcut: "F",
      placement: "footer",
      focused: true,
    });
  });

  it("projects long value lists completely with stable semantic identities and slots", () => {
    const options = Array.from({ length: 12 }, (_, index) => ({
      id: `project-${index}`,
      label: `Project ${index}`,
    }));
    const model = dashboardFilterConditionPanelModel({
      screen: filterScreen({
        stage: "values",
        field: "project",
        focusedValueId: "project-6",
        options,
        selectedIds: ["project-6"],
      }),
    });

    expect(model).toMatchObject({
      stage: "values",
      title: "PROJECT CONDITION",
      actions: [
        { id: "back", label: "←", placement: "header" },
        { id: "close", label: "×", placement: "header" },
        {
          id: "done",
          label: "Done",
          shortcut: "Enter",
          placement: "footer",
          focused: false,
        },
      ],
    });
    expect(model?.rows).toHaveLength(12);
    expect(
      model?.rows.flatMap((row) =>
        row.kind === "value" && ["project-0", "project-6", "project-11"].includes(row.valueId)
          ? [[row.id, row.key, row.valueId, row.marker, row.checked]]
          : [],
      ),
    ).toEqual([
      ["value:project:project-0", "1", "project-0", " ", false],
      ["value:project:project-6", "7", "project-6", "▸", true],
      ["value:project:project-11", "c", "project-11", " ", false],
    ]);
  });

  it("returns no panel while the filter text editor owns input", () => {
    expect(
      dashboardFilterConditionPanelModel({
        screen: filterScreen(undefined),
      }),
    ).toBeUndefined();
  });
});
