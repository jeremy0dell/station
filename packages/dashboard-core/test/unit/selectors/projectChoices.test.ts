import { describe, expect, it } from "vitest";
import {
  selectNewSessionProjectChoices,
  selectProjectChooserChoices,
} from "../../../src/selectors/projectChoices.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("Project choices", () => {
  it("assigns Project choices from snapshot order", () => {
    const choices = selectProjectChooserChoices(createDashboardSnapshot());
    expect(choices.map((choice) => [choice.key, choice.value.id])).toEqual([
      ["1", "web"],
      ["2", "api"],
    ]);
  });

  it("keeps Projects beyond the shortcut alphabet in the semantic picker", () => {
    const base = createDashboardSnapshot();
    const template = base.projects[0];
    if (template === undefined) throw new Error("missing Project fixture");
    const snapshot = {
      ...base,
      projects: Array.from({ length: 36 }, (_, index) => ({
        ...template,
        id: `project-${index + 1}`,
        label: `Project ${index + 1}`,
      })),
    };

    const choices = selectProjectChooserChoices(snapshot);

    expect(choices).toHaveLength(36);
    expect(choices.at(-2)).toMatchObject({ key: "z", value: { id: "project-35" } });
    expect(choices.at(-1)).toEqual({
      value: expect.objectContaining({ id: "project-36" }),
    });
  });

  it("keys New Session Projects from the shared shortcut grammar", () => {
    expect(
      selectNewSessionProjectChoices(createDashboardSnapshot()).map((choice) => [
        choice.key,
        choice.value.id,
      ]),
    ).toEqual([
      ["1", "web"],
      ["2", "api"],
    ]);
  });
});
