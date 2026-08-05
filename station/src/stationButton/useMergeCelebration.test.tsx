import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { StationClientStateSource } from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { makeStationTestRuntime } from "../station/test/support/makeStationTestRuntime.js";
import { useMergeCelebration } from "./useMergeCelebration.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const SURFACE = { width: 30, height: 4 };

function CelebrationProbe({
  source,
  ttlMs,
}: {
  source: StationClientStateSource;
  ttlMs: number;
}) {
  const celebration = useMergeCelebration(source, ttlMs);
  return (
    <text>
      {celebration === undefined
        ? "quiet"
        : `pr:${celebration.prNumber}:${celebration.title ?? ""}`}
    </text>
  );
}

function withMergedPr(snapshot: StationSnapshot, worktreeId: string): StationSnapshot {
  return {
    ...snapshot,
    rows: snapshot.rows.map((row) => {
      const pr = row.worktree.pr;
      if (row.id !== worktreeId || pr === undefined) {
        return row;
      }
      return { ...row, worktree: { ...row.worktree, pr: { ...pr, state: "merged" as const, title: "ship it" } } };
    }),
  };
}

describe("useMergeCelebration", () => {
  it("celebrates a PR flipping to merged, then quiets after the TTL", async () => {
    const snapshot = manyProjectsSnapshot();
    const fixture = makeStationTestRuntime({ snapshot });
    const setup = await testRender(
      <CelebrationProbe source={fixture.source} ttlMs={60} />,
      SURFACE,
    );
    try {
      await setup.flush();
      // Let the hook's effect mount and seed its baseline from the initial
      // snapshot before any update arrives.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The initial snapshot already holds a merged PR (wt_station_idle #73):
      // first sight never celebrates.
      expect(setup.captureCharFrame()).toContain("quiet");

      fixture.source.setSnapshot(withMergedPr(snapshot, "wt_station_working"));
      // The state update commits on the next macrotask beat.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
      expect(
        fixture.runtime.state.getState().snapshot?.rows.find(
          (row) => row.id === "wt_station_working",
        )?.worktree.pr?.state,
      ).not.toBe("merged");
      expect(setup.captureCharFrame()).toContain("pr:76:ship it");

      await new Promise((resolve) => setTimeout(resolve, 120));
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("quiet");
    } finally {
      fixture.runtime.dispose();
      setup.renderer.destroy();
    }
  });
});
