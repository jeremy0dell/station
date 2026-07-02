import type { WorktreeChecksSummary, WorktreePullRequest, WorktreeRow } from "@station/contracts";
import type { RowGridCellImportance } from "../components/WorktreeRow/layout.js";
import type { ColorRole } from "./colors.js";
import { CHECK_GLYPHS, STATUS_GLYPHS, THROBBERS } from "./glyphs.js";

export type StatusMarkerAtom =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "throbber";
      variant: "braille" | "circle";
    };

export type WorktreeStatusAtom = {
  marker: StatusMarkerAtom;
  activity: string;
  activityImportance: RowGridCellImportance;
  rowColor?: ColorRole;
  markerColor?: ColorRole;
  activityColor?: ColorRole;
};

export type MetadataAtom = {
  group: "diff" | "pr";
  text: string;
  stale: boolean;
  color?: ColorRole;
  underline?: true;
  url?: string;
};

export function worktreeStatusAtom(row: WorktreeRow): WorktreeStatusAtom {
  const state = row.agent?.state ?? "none";
  const activity = activityForRow(row);
  const atom: WorktreeStatusAtom = {
    marker: markerForState(row),
    activity: activity.text,
    activityImportance: activity.importance,
  };
  if (row.display.alert || row.display.warning === true) {
    atom.rowColor = row.display.alert ? "red" : "yellow";
  } else if (state === "unknown") {
    atom.rowColor = "yellow";
  }
  if (isReadyToRead(row)) {
    atom.markerColor = "green";
    atom.activityColor = "green";
  }
  return atom;
}

export function worktreeMetadataAtoms(row: WorktreeRow): MetadataAtom[] {
  return [...diffMetadataAtoms(row), ...prMetadataAtoms(row)];
}

export function diffMetadataAtoms(row: WorktreeRow): MetadataAtom[] {
  const { changeSummary } = row.worktree;
  if (changeSummary === undefined) {
    return [];
  }
  const atoms: MetadataAtom[] = [];
  if (changeSummary.additions > 0) {
    atoms.push({
      group: "diff",
      text: `+${changeSummary.additions}`,
      stale: changeSummary.stale === true,
      color: "green",
    });
  }
  if (changeSummary.deletions > 0) {
    atoms.push({
      group: "diff",
      text: `-${changeSummary.deletions}`,
      stale: changeSummary.stale === true,
      color: "red",
    });
  }
  return atoms;
}

export function prMetadataAtoms(row: WorktreeRow): MetadataAtom[] {
  const { checks, pr } = row.worktree;
  if (pr === undefined) {
    return [];
  }
  const atoms: MetadataAtom[] = [pullRequestMetadataAtom(pr)];
  if (checks !== undefined) {
    atoms.push(checkMetadataAtom(checks, pr));
  }
  return atoms;
}

export function pullRequestMetadataAtom(pr: WorktreePullRequest): MetadataAtom {
  const atom: MetadataAtom = {
    group: "pr",
    text: `#${pr.number}`,
    stale: pr.stale === true,
    color: pr.state === "merged" ? "purple" : "blue",
    underline: true,
  };
  if (pr.url !== undefined) {
    atom.url = pr.url;
  }
  return atom;
}

export function checkMetadataAtom(
  checks: WorktreeChecksSummary,
  pr: WorktreePullRequest,
): MetadataAtom {
  return {
    group: "pr",
    text: checksStateGlyph(checks),
    stale: checks.stale === true,
    color: checksStateColor(checks, pr),
  };
}

function activityForRow(row: WorktreeRow): {
  text: string;
  importance: RowGridCellImportance;
} {
  if (row.display.alert || row.display.warning === true) {
    return {
      text: row.display.reason ?? row.display.statusLabel,
      importance: "meaningful",
    };
  }
  if (isReadyToRead(row)) {
    return {
      text: "ready",
      importance: "optional",
    };
  }
  return {
    text: row.display.statusLabel,
    importance: "optional",
  };
}

function markerForState(row: WorktreeRow): StatusMarkerAtom {
  const state = row.agent?.state ?? "none";
  switch (state) {
    case "needs_attention":
    case "stuck":
      return { kind: "text", text: STATUS_GLYPHS.attention };
    case "working":
      return THROBBERS.working;
    case "idle":
      return isReadyToRead(row)
        ? { kind: "text", text: STATUS_GLYPHS.ready }
        : { kind: "text", text: STATUS_GLYPHS.idle };
    case "starting":
      return { kind: "text", text: STATUS_GLYPHS.starting };
    case "unknown":
      return { kind: "text", text: STATUS_GLYPHS.unknown };
    case "exited":
      return { kind: "text", text: STATUS_GLYPHS.exited };
    case "none":
      return { kind: "text", text: STATUS_GLYPHS.noAgent };
  }
}

function isReadyToRead(row: WorktreeRow): boolean {
  return row.agent?.state === "idle" && row.agent.turnReadiness?.state === "ready_to_read";
}

function checksStateGlyph(checks: WorktreeChecksSummary): string {
  switch (checks.state) {
    case "pass":
      return CHECK_GLYPHS.pass;
    case "fail":
      return failedChecksGlyph(checks.failed);
    case "cancelled":
      return failedChecksGlyph(checks.cancelled);
    case "running":
      return CHECK_GLYPHS.running;
    case "none":
    case "unknown":
    case "skipped":
      return CHECK_GLYPHS.fallback;
  }
}

function failedChecksGlyph(count: number | undefined): string {
  return count === undefined || count <= 0 ? "x" : `x${count}`;
}

function checksStateColor(checks: WorktreeChecksSummary, pr: WorktreePullRequest): ColorRole {
  if (pr.state === "merged" && checks.state === "pass") return "purple";
  if (checks.state === "pass") return "green";
  if (checks.state === "fail" || checks.state === "cancelled") return "red";
  if (checks.state === "running") return "yellow";
  return "gray";
}
