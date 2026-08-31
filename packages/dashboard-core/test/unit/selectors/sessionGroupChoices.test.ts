import { describe, expect, it } from "vitest";
import {
  selectMoveToGroupChoices,
  selectMoveToGroupSessionContext,
  selectNewSessionGroupChoices,
  selectNewSessionRootGroup,
} from "../../../src/selectors/sessionGroupChoices.js";
import { createGroupedDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("Session Group choices", () => {
  it("projects only same-Project root Groups for New Session", () => {
    const snapshot = createGroupedDashboardSnapshot();

    expect(
      selectNewSessionGroupChoices(snapshot, "web").map((choice) => [choice.key, choice.value.id]),
    ).toEqual([
      ["1", "group_active"],
      ["2", "group_empty"],
    ]);
    expect(selectNewSessionRootGroup(snapshot, "web", "group_build")).toBeUndefined();
    expect(selectNewSessionRootGroup(snapshot, "web", "group_api")).toBeUndefined();
  });

  it("projects Move-to-Group choices from canonical session context", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const context = selectMoveToGroupSessionContext(snapshot, "ses_wt_web_idle");

    expect(context).toMatchObject({
      session: { id: "ses_wt_web_idle" },
      project: { id: "web" },
      currentGroup: { id: "group_active" },
    });
    expect(
      selectMoveToGroupChoices(snapshot, "ses_wt_web_idle").map((choice) => choice.value.id),
    ).toEqual(["group_active", "group_empty"]);
    expect(selectMoveToGroupChoices(snapshot, "missing")).toEqual([]);
  });
});
