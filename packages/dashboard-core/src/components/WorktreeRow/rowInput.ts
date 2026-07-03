import type { WorktreeRow as WorktreeRowModel } from "@station/contracts";
import {
  type RowColor,
  type RowGridCell,
  type RowGridCellImportance,
  type RowGridCellKey,
  type RowGridRowInput,
  type RowMarker,
  type RowSegment,
  textSegment,
  type WorktreeRowMetadataGroups,
} from "./layout.js";

export function worktreeRowGridInput({
  id,
  row,
  slot,
  title,
  focused,
}: {
  id?: string;
  row: WorktreeRowModel;
  slot: string | undefined;
  title?: string | undefined;
  focused?: boolean | undefined;
}): RowGridRowInput {
  const marker = statusMarker(row);
  const displayTitle = title ?? row.branch;
  const activity = activityCellForRow(row);
  const ready = isReadyToRead(row);
  const state = row.agent?.state ?? "none";
  const input: Parameters<typeof worktreeStyleRowGridInput>[0] = {
    id: id ?? row.id,
    slot,
    marker,
    title: displayTitle,
    agent: row.agent?.harness ?? "-",
    activity: activity.text,
    activityImportance: activity.importance,
    // Let the status claim the row's trailing slack so it stretches to the end
    // instead of truncating while empty space remains, matching transient rows.
    activityOverflow: "rowSlack",
    metadataGroups: metadataGroups(row),
  };
  // Tone colors the glyph + status label only — the session name must stay
  // foreground in every state (D12/D13).
  const tone = rowStatusTone(row, ready, state);
  if (tone === "gray") {
    input.activityColor = "gray";
    input.agentColor = "gray";
  } else {
    input.markerColor = tone;
    input.activityColor = tone;
  }
  if (focused === true) {
    input.focused = true;
  }
  return worktreeStyleRowGridInput(input);
}

export function worktreeStyleRowGridInput(input: {
  id: string;
  slot: string | undefined;
  marker: RowMarker;
  title: string;
  agent?: string;
  activity?: string;
  activityImportance?: RowGridCellImportance;
  activityOverflow?: RowGridCell["overflow"];
  color?: RowColor;
  markerColor?: RowColor;
  activityColor?: RowColor;
  agentColor?: RowColor;
  metadataGroups?: WorktreeRowMetadataGroups;
  focused?: true;
}): RowGridRowInput {
  const cells: Partial<Record<RowGridCellKey, RowGridCell>> = {};
  cells.identity = {
    key: "identity",
    segments: identitySegments(
      input.slot,
      input.marker,
      input.color,
      input.markerColor,
      input.focused,
    ),
    importance: "required",
  };
  cells.title = {
    key: "title",
    segments: [textSegment(input.title, { color: input.color })],
    importance: "required",
  };
  if (input.agent !== undefined) {
    cells.agent = {
      key: "agent",
      segments: [textSegment(input.agent, { color: input.agentColor ?? input.color })],
      importance: "optional",
    };
  }
  if (input.activity !== undefined) {
    cells.activity = {
      key: "activity",
      segments: [textSegment(input.activity, { color: input.activityColor ?? input.color })],
      importance: input.activityImportance ?? "optional",
    };
    if (input.activityOverflow !== undefined) {
      cells.activity.overflow = input.activityOverflow;
    }
  }
  if (input.metadataGroups !== undefined) {
    const metadata = metadataCellSegments(input.metadataGroups);
    if (metadata.length > 0) {
      cells.metadata = {
        key: "metadata",
        segments: metadata,
        importance: "optional",
      };
    }
  }

  const row: RowGridRowInput = {
    id: input.id,
    cells,
  };
  if (input.metadataGroups !== undefined) {
    row.metadataGroups = input.metadataGroups;
  }
  if (input.color !== undefined) {
    row.color = input.color;
  }
  return row;
}

function identitySegments(
  slot: string | undefined,
  marker: RowMarker,
  color: RowColor | undefined,
  markerColor: RowColor | undefined,
  focused: true | undefined,
): RowSegment[] {
  // The cursor reuses the identity cell's leading pad cell, so a focused row
  // never shifts the shared grid geometry.
  const segments: RowSegment[] = [
    focused === true ? textSegment("▏", { color: "cyan" }) : textSegment(" ", { color }),
    textSegment(`[${slot ?? " "}] `, { color }),
  ];
  if (marker.kind === "throbber") {
    const throbberColor = markerColor ?? color;
    segments.push(
      throbberColor === undefined
        ? { kind: "throbber", variant: marker.variant }
        : { kind: "throbber", variant: marker.variant, color: throbberColor },
    );
  } else {
    segments.push(textSegment(marker.text, { color: markerColor ?? color }));
  }
  segments.push(textSegment(" ", { color }));
  return segments;
}

function activityCellForRow(row: WorktreeRowModel): {
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
      text: "idle · ready",
      importance: "optional",
    };
  }
  return {
    text: row.display.statusLabel,
    importance: "optional",
  };
}

// Keep the branch order in sync with statusMarker's ladder.
function rowStatusTone(
  row: WorktreeRowModel,
  ready: boolean,
  state: string,
): "red" | "yellow" | "green" | "blue" | "gray" {
  if (row.display.alert) return "red";
  if (state === "working") return "blue";
  if (ready) return "green";
  if (state === "unknown") return "yellow";
  return "gray";
}

export function statusMarker(row: WorktreeRowModel): RowMarker {
  const state = row.agent?.state ?? "none";
  if (state === "needs_attention" || state === "stuck") return { kind: "text", text: "!" };
  if (state === "working") return { kind: "throbber", variant: "braille" };
  if (isReadyToRead(row)) return { kind: "text", text: "●" };
  if (state === "idle") return { kind: "text", text: "○" };
  if (state === "starting") return { kind: "text", text: "+" };
  if (state === "unknown") return { kind: "text", text: "?" };
  if (state === "exited") return { kind: "text", text: "x" };
  return { kind: "text", text: "-" };
}

export function isReadyToRead(row: WorktreeRowModel): boolean {
  return row.agent?.state === "idle" && row.agent.turnReadiness?.state === "ready_to_read";
}

type MetadataSegment = {
  text: string;
  stale: boolean;
  color?: MetadataColor;
  underline?: true;
  url?: string;
};

type MetadataColor = RowColor;

export function metadataSegments(row: WorktreeRowModel): MetadataSegment[] {
  const segments: MetadataSegment[] = [];
  const { changeSummary, pr, checks } = row.worktree;
  if (changeSummary !== undefined && (changeSummary.additions > 0 || changeSummary.deletions > 0)) {
    if (changeSummary.additions > 0) {
      segments.push({
        text: `+${changeSummary.additions}`,
        stale: changeSummary.stale === true,
        color: "green",
      });
    }
    if (changeSummary.deletions > 0) {
      segments.push({
        text: `-${changeSummary.deletions}`,
        stale: changeSummary.stale === true,
        color: "red",
      });
    }
  }
  if (pr === undefined) {
    return segments;
  }
  segments.push({
    text: `#${pr.number}`,
    stale: pr.stale === true,
    color: prMetadataColor(pr),
    underline: true,
    ...(pr.url === undefined ? {} : { url: pr.url }),
  });
  if (checks !== undefined) {
    segments.push({
      text: checksStateGlyph(checks),
      stale: checks.stale === true,
      color: checksStateColor(checks, pr),
    });
  }
  return segments;
}

function metadataGroups(row: WorktreeRowModel): WorktreeRowMetadataGroups {
  const segments = metadataSegments(row).map(rowSegmentFromMetadata);
  const diffCount = diffMetadataSegmentCount(row);
  return {
    diff: segments.slice(0, diffCount),
    pr: segments.slice(diffCount),
  };
}

function metadataCellSegments(groups: WorktreeRowMetadataGroups): RowSegment[] {
  const segments: RowSegment[] = [];
  [...groups.diff, ...groups.pr].forEach((segment, index) => {
    if (index > 0) {
      segments.push(textSegment(" "));
    }
    segments.push(segment);
  });
  return segments;
}

function rowSegmentFromMetadata(segment: MetadataSegment): RowSegment {
  return textSegment(segment.text, {
    color: segment.color,
    dimColor: segment.stale ? true : undefined,
    underline: segment.underline,
    url: segment.url,
  });
}

function diffMetadataSegmentCount(row: WorktreeRowModel): number {
  const { changeSummary } = row.worktree;
  if (changeSummary === undefined) {
    return 0;
  }
  let count = 0;
  if (changeSummary.additions > 0) count += 1;
  if (changeSummary.deletions > 0) count += 1;
  return count;
}

function checksStateGlyph(checks: NonNullable<WorktreeRowModel["worktree"]["checks"]>) {
  if (checks.state === "pass") return "✓";
  if (checks.state === "fail") return failedChecksGlyph(checks.failed);
  if (checks.state === "cancelled") return failedChecksGlyph(checks.cancelled);
  if (checks.state === "running") return "…";
  return "-";
}

function prMetadataColor(pr: NonNullable<WorktreeRowModel["worktree"]["pr"]>): MetadataColor {
  return pr.state === "merged" ? "purple" : "blue";
}

function failedChecksGlyph(count: number | undefined): string {
  return count === undefined || count <= 0 ? "x" : `x${count}`;
}

function checksStateColor(
  checks: NonNullable<WorktreeRowModel["worktree"]["checks"]>,
  pr: NonNullable<WorktreeRowModel["worktree"]["pr"]>,
): MetadataColor {
  if (pr.state === "merged" && checks.state === "pass") return "purple";
  if (checks.state === "pass") return "green";
  if (checks.state === "fail" || checks.state === "cancelled") return "red";
  if (checks.state === "running") return "yellow";
  return "gray";
}
