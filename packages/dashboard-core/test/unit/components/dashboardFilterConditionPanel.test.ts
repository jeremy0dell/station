import { dashboardFilterConditionPanelModel, type TuiScreen } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

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
      screen: filterScreen({ stage: "field", cursor: 1 }),
      columns: 20,
      availableRows: 10,
    });

    expect(model).toMatchObject({
      stage: "field",
      title: "FILTER CONDITIONS",
      width: 18,
      hiddenAbove: 0,
      hiddenBelow: 0,
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
      screen: filterScreen({ stage: "field", cursor: 3 }),
      columns: 50,
      availableRows: 10,
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

  it("windows long value lists while retaining absolute stable slot assignments", () => {
    const options = Array.from({ length: 12 }, (_, index) => ({
      id: `project-${index}`,
      label: `Project ${index}`,
    }));
    const model = dashboardFilterConditionPanelModel({
      screen: filterScreen({
        stage: "values",
        field: "project",
        cursor: 6,
        options,
        selectedIds: ["project-6"],
      }),
      columns: 60,
      availableRows: 6,
    });

    expect(model).toMatchObject({
      stage: "values",
      title: "PROJECT CONDITION",
      height: 6,
      hiddenAbove: 5,
      hiddenBelow: 5,
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
    expect(
      model?.rows.flatMap((row) =>
        row.kind === "value" ? [[row.key, row.valueId, row.marker, row.checked]] : [],
      ),
    ).toEqual([
      ["6", "project-5", " ", false],
      ["7", "project-6", "▸", true],
    ]);
  });

  it("returns no panel while the filter text editor owns input", () => {
    expect(
      dashboardFilterConditionPanelModel({
        screen: filterScreen(undefined),
        columns: 80,
        availableRows: 20,
      }),
    ).toBeUndefined();
  });
});
