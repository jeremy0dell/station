import { describe, expect, it } from "vitest";
import {
  chooseNewSessionProjectById,
  createNewSessionFlow,
  transitionNewSessionFlow,
} from "../../../../src/flows/newSession/flow.js";
import { reconcileNewSessionFlow } from "../../../../src/flows/newSession/reconciliation.js";
import { createGroupedDashboardSnapshot } from "../../../fixtures/snapshots.js";

describe("New Session reconciliation", () => {
  it("resets Group placement on project change and invalid snapshot replacement", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const opened = createNewSessionFlow(snapshot, "aaaaaa", {
      projectId: "web",
      groupId: "group_active",
    });
    if (opened === undefined) throw new Error("expected a flow");
    const projectPicker = transitionNewSessionFlow(opened, { type: "pickProject" });
    if (projectPicker?.mode !== "pickProject") throw new Error("expected project picker");
    expect(chooseNewSessionProjectById(projectPicker, snapshot, "api", "bbbbbb")).toMatchObject({
      selectedProjectId: "api",
      groupSelection: { kind: "ungrouped" },
    });

    const renamed = {
      ...snapshot,
      sessionGroups: snapshot.sessionGroups.map((group) =>
        group.id === "group_active" ? { ...group, name: "Renamed", version: 2 } : group,
      ),
    };
    expect(reconcileNewSessionFlow(opened, renamed).groupSelection).toEqual({
      kind: "existing",
      groupId: "group_active",
    });

    for (const invalid of [
      {
        ...snapshot,
        sessionGroups: snapshot.sessionGroups.filter((group) => group.id !== "group_active"),
      },
      {
        ...snapshot,
        sessionGroups: snapshot.sessionGroups.map((group) =>
          group.id === "group_active" ? { ...group, parentGroupId: "group_empty" } : group,
        ),
      },
    ]) {
      expect(reconcileNewSessionFlow(opened, invalid).groupSelection).toEqual({
        kind: "ungrouped",
      });
    }
  });
});
