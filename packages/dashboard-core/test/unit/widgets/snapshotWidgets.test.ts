import type { StationSnapshot } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { resolveTopRowWidgets } from "../../../src/widgets/snapshotWidgets.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

function withPrStates(snapshot: StationSnapshot): StationSnapshot {
  const states = new Map<string, "open" | "draft" | "merged">([
    ["wt_web_working", "open"],
    ["wt_web_idle", "draft"],
    ["wt_api_working", "merged"],
  ]);
  return {
    ...snapshot,
    rows: snapshot.rows.map((row) => {
      const state = states.get(row.id);
      if (state === undefined) {
        return row;
      }
      return { ...row, worktree: { ...row.worktree, pr: { number: 7, state } } };
    }),
  };
}

describe("resolveTopRowWidgets", () => {
  it("fills fleet and open-PR counts from the snapshot", () => {
    const snapshot = withPrStates(createDashboardSnapshot());
    const resolved = resolveTopRowWidgets(
      [
        { id: "time:0", text: "10:42 AM" },
        { id: "fleet:1", text: "", data: "fleet" },
        { id: "prs:2", text: "", data: "prs" },
      ],
      snapshot,
    );
    expect(resolved.map((widget) => widget.text)).toEqual([
      "10:42 AM",
      // Fixture rows: 2 working + attention + stuck + 1 idle are live;
      // exited/unknown/no-agent are not.
      "5 agents",
      // open + draft count as open PRs; merged does not.
      "2 open PRs",
    ]);
    expect(resolved[2]?.compact).toBe("2 PRs");
  });

  it("drops snapshot widgets when no snapshot has arrived", () => {
    const resolved = resolveTopRowWidgets(
      [
        { id: "fleet:0", text: "", data: "fleet" },
        { id: "time:1", text: "10:42 AM" },
      ],
      undefined,
    );
    expect(resolved).toEqual([{ id: "time:1", text: "10:42 AM" }]);
  });

  it("uses singular nouns for counts of one", () => {
    const base = createDashboardSnapshot();
    const oneAgent: StationSnapshot = {
      ...base,
      rows: base.rows.filter((row) => row.id === "wt_web_working"),
    };
    const resolved = resolveTopRowWidgets([{ id: "fleet:0", text: "", data: "fleet" }], oneAgent);
    expect(resolved[0]?.text).toBe("1 agent");
  });
});
