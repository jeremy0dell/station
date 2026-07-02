import type { WorktreeChecksSummary, WorktreePullRequest, WorktreeRow } from "@station/contracts";
import {
  checkMetadataAtom,
  pullRequestMetadataAtom,
  worktreeRowGridInput,
  worktreeStatusAtom,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { fixtureNow, row } from "../../../fixtures/snapshots.js";

function fixtureRow(state: "none" | NonNullable<WorktreeRow["agent"]>["state"]): WorktreeRow {
  const built = row({
    id: `wt_${state}`,
    projectId: "web",
    branch: `branch-${state}`,
    state,
  });
  return {
    ...built,
    display: {
      ...built.display,
      statusLabel: statusLabel(state),
    },
  };
}

function statusLabel(state: "none" | NonNullable<WorktreeRow["agent"]>["state"]) {
  switch (state) {
    case "needs_attention":
      return "needs attention";
    case "none":
      return "no agent";
    default:
      return state;
  }
}

describe("worktree status tokens", () => {
  it("emits semantic status atoms for every agent state", () => {
    expect(worktreeStatusAtom(fixtureRow("none"))).toMatchObject({
      marker: { kind: "text", text: "-" },
      activity: "no agent",
    });
    expect(worktreeStatusAtom(fixtureRow("starting"))).toMatchObject({
      marker: { kind: "text", text: "+" },
      activity: "starting",
    });
    expect(worktreeStatusAtom(fixtureRow("idle"))).toMatchObject({
      marker: { kind: "text", text: "○" },
      activity: "idle",
    });
    expect(worktreeStatusAtom(fixtureRow("working"))).toMatchObject({
      marker: { kind: "throbber", variant: "braille" },
      activity: "working",
    });
    expect(worktreeStatusAtom(fixtureRow("needs_attention"))).toMatchObject({
      marker: { kind: "text", text: "!" },
      rowColor: "red",
      activityImportance: "meaningful",
    });
    expect(worktreeStatusAtom(fixtureRow("stuck"))).toMatchObject({
      marker: { kind: "text", text: "!" },
      rowColor: "red",
      activityImportance: "meaningful",
    });
    expect(worktreeStatusAtom(fixtureRow("exited"))).toMatchObject({
      marker: { kind: "text", text: "x" },
      activity: "exited",
    });
    expect(worktreeStatusAtom(fixtureRow("unknown"))).toMatchObject({
      marker: { kind: "text", text: "?" },
      rowColor: "yellow",
      activity: "unknown",
    });
  });

  it("colors idle ready-to-read rows with the ready role", () => {
    const base = fixtureRow("idle");
    const ready = {
      ...base,
      agent:
        base.agent === undefined
          ? undefined
          : {
              ...base.agent,
              turnReadiness: {
                state: "ready_to_read" as const,
                token: "report_ready",
                completedAt: fixtureNow,
              },
            },
    } satisfies WorktreeRow;

    expect(worktreeStatusAtom(ready)).toMatchObject({
      marker: { kind: "text", text: "●" },
      activity: "ready",
      markerColor: "green",
      activityColor: "green",
    });
  });
});

describe("worktree metadata tokens", () => {
  const openPr = {
    number: 12,
    state: "open",
    url: "https://github.com/example/station/pull/12",
  } satisfies WorktreePullRequest;
  const mergedPr = {
    number: 73,
    state: "merged",
  } satisfies WorktreePullRequest;

  it("keeps PR number as metadata and resolves merged PRs semantically", () => {
    expect(pullRequestMetadataAtom(openPr)).toMatchObject({
      text: "#12",
      group: "pr",
      color: "blue",
      underline: true,
      url: openPr.url,
    });
    expect(pullRequestMetadataAtom(mergedPr)).toMatchObject({
      text: "#73",
      group: "pr",
      color: "purple",
      underline: true,
    });
  });

  it("emits semantic check glyphs and colors", () => {
    expect(checkMetadataAtom(checks("pass"), openPr)).toMatchObject({
      text: "✓",
      color: "green",
    });
    expect(checkMetadataAtom(checks("pass"), mergedPr)).toMatchObject({
      text: "✓",
      color: "purple",
    });
    expect(checkMetadataAtom(checks("running"), openPr)).toMatchObject({
      text: "…",
      color: "yellow",
    });
    expect(checkMetadataAtom({ ...checks("fail"), failed: 2 }, openPr)).toMatchObject({
      text: "x2",
      color: "red",
    });
    expect(checkMetadataAtom({ ...checks("cancelled"), cancelled: 3 }, openPr)).toMatchObject({
      text: "x3",
      color: "red",
    });
  });

  it("assembles row metadata without leaking hex into dashboard-core rows", () => {
    const merged = fixtureRow("idle");
    merged.worktree.pr = mergedPr;
    merged.worktree.checks = checks("pass");

    const input = worktreeRowGridInput({ row: merged, slot: "1" });
    const colors = input.cells.metadata?.segments.flatMap((segment) =>
      segment.kind === "text" && segment.color !== undefined ? [segment.color] : [],
    );

    expect(colors).toEqual(["purple", "purple"]);
  });
});

function checks(state: WorktreeChecksSummary["state"]): WorktreeChecksSummary {
  return {
    state,
    source: "github",
    checkedAt: fixtureNow,
  };
}
