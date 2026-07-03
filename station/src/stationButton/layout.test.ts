import { describe, expect, it } from "bun:test";
import {
  attentionLines,
  celebrationText,
  COLLAPSED_BASE_COLS,
  COLLAPSED_COUNTS_COLS,
  islandDisplay,
  type IslandDisplayInput,
  targetDims,
} from "./layout.js";
import type { StationButtonStatus } from "./status.js";

const CALM_STATUS: StationButtonStatus = {
  attention: false,
  needsYouCount: 0,
  workingCount: 0,
  readyCount: 0,
  idleCount: 0,
};

function input(
  status: Partial<StationButtonStatus> = {},
  extra: Omit<IslandDisplayInput, "status"> = {},
): IslandDisplayInput {
  return { status: { ...CALM_STATUS, ...status }, ...extra };
}

function dims(value: IslandDisplayInput, expanded: boolean) {
  return targetDims(islandDisplay(value, expanded));
}

describe("islandDisplay", () => {
  it("ranks attention over celebration over counts over the bare mark", () => {
    const celebration = { prNumber: 42 };
    expect(
      islandDisplay(input({ attention: true }, { celebration, restCounts: true }), false).kind,
    ).toBe("alertMark");
    expect(islandDisplay(input({}, { celebration, restCounts: true }), false).kind).toBe(
      "celebration",
    );
    expect(islandDisplay(input({}, { restCounts: true }), false).kind).toBe("counts");
    expect(islandDisplay(input(), false).kind).toBe("mark");
  });

  it("expands to the alert card, the roll-up, or the totals", () => {
    expect(islandDisplay(input({ attention: true, needsYouCount: 2 }), true).kind).toBe(
      "alertCard",
    );
    const rollup = [{ projectId: "p1", name: "station", status: "idle" as const }];
    expect(islandDisplay(input({ projectRollup: rollup }), true).kind).toBe("rollup");
    const summary = islandDisplay(input({ workingCount: 2, readyCount: 1, idleCount: 3 }), true);
    // Ready folds into the idle total.
    expect(summary).toEqual({ kind: "summary", working: 2, idle: 4 });
  });
});

describe("targetDims", () => {
  it("keeps the summary card width stable as live counts change", () => {
    const width = (workingCount: number, idleCount: number): number =>
      dims(input({ workingCount, idleCount }), true).width;
    expect(width(1, 1)).toBe(width(2, 14));
    expect(width(2, 14)).toBe(width(9, 99));
    expect(width(0, 0)).toBe(width(12, 7));
  });

  it("keeps the alert card width stable as the session name changes", () => {
    const width = (sessionName: string): number =>
      dims(input({ attention: true, sessionName }), true).width;
    expect(width("feature/a-quite-long-branch-name")).toBe(width("x"));
    expect(width("x")).toBe(width("main"));
    expect(width("main")).toBe(width("another/long-feature-branch-name-here"));
  });

  it("keeps the collapsed counts box width stable as counts tick", () => {
    const at = (workingCount: number, readyCount: number, idleCount: number) =>
      dims(input({ workingCount, readyCount, idleCount }, { restCounts: true }), false);
    expect(at(0, 0, 0)).toEqual(at(9, 10, 99));
    expect(at(1, 1, 1).width).toBe(COLLAPSED_COUNTS_COLS);
    expect(at(1, 1, 1).width).toBeGreaterThan(COLLAPSED_BASE_COLS);
    expect(at(150, 0, 0)).toEqual(at(0, 0, 0));
  });

  it("keeps the roll-up card width fixed while height tracks project count", () => {
    const at = (projects: number) =>
      dims(
        input({
          projectRollup: Array.from({ length: projects }, (_, i) => ({
            projectId: `p${i}`,
            name: `proj-${i}`,
            status: "idle" as const,
          })),
        }),
        true,
      );
    expect(at(1).width).toBe(at(8).width);
    expect(at(2).height).toBe(at(1).height + 1);
    expect(at(6).height).toBe(at(9).height);
    // An empty roll-up falls back to the totals card.
    expect(at(0)).toEqual(dims(input(), true));
  });

  it("sizes the celebration box to its text and stays put while it shows", () => {
    const at = (celebration: { prNumber: number; title?: string }) =>
      dims(input({}, { celebration }), false);
    expect(at({ prNumber: 42 })).toEqual(at({ prNumber: 42 }));
    expect(at({ prNumber: 12345 }).width).toBe(at({ prNumber: 42 }).width + 3);
    expect(at({ prNumber: 42 }).height).toBe(dims(input(), false).height);
    expect(at({ prNumber: 42, title: "fix things" }).width).toBe(
      at({ prNumber: 42 }).width + " · fix things".length,
    );
  });
});

describe("celebrationText", () => {
  it("appends the PR title, clamped to the stable budget", () => {
    expect(celebrationText({ prNumber: 42 })).toBe("✓ #42 merged");
    expect(celebrationText({ prNumber: 42, title: "fix the hooks" })).toBe(
      "✓ #42 merged · fix the hooks",
    );
    const long = celebrationText({
      prNumber: 42,
      title: "a very long pull request title that keeps going",
    });
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBe("✓ #42 merged · ".length + 28);
  });
});

describe("attentionLines", () => {
  it("swaps to the queue line only when several sessions ask", () => {
    expect(attentionLines(1)).toEqual(["needs your attention", "↵ or click to focus"]);
    expect(attentionLines(3)).toEqual(["! 3 need you ›", "↵ or click to focus"]);
    expect(attentionLines(120)[0]).toBe("! 99 need you ›");
  });
});
