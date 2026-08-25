import type { AgentState, WorktreeRow } from "@station/contracts";
import { isReadyToRead } from "../../selectors/agentStatus.js";
import { type TextMatchRange, textMatchSegments } from "../TextMatch/segments.js";
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

export type WorktreeRowTextHighlights = {
  title?: readonly TextMatchRange[];
  agent?: readonly TextMatchRange[];
  activity?: readonly TextMatchRange[];
};

export type WorktreeRowPresentation = {
  title: string;
  agent: string;
  activity: string;
};

type AgentVisual = { marker: RowMarker; tone: RowColor };

const AGENT_VISUALS: Record<AgentState, AgentVisual> = {
  needs_attention: { marker: { kind: "text", text: "!" }, tone: "red" },
  stuck: { marker: { kind: "text", text: "!" }, tone: "red" },
  working: { marker: { kind: "throbber", variant: "braille" }, tone: "blue" },
  starting: { marker: { kind: "text", text: "+" }, tone: "gray" },
  idle: { marker: { kind: "text", text: "○" }, tone: "gray" },
  unknown: { marker: { kind: "text", text: "?" }, tone: "yellow" },
  exited: { marker: { kind: "text", text: "x" }, tone: "gray" },
  none: { marker: { kind: "text", text: "-" }, tone: "gray" },
};

const READY_TO_READ_VISUAL: AgentVisual = { marker: { kind: "text", text: "●" }, tone: "green" };

export function worktreeRowGridInput({
  id,
  row,
  slot,
  title,
  presentation,
  focused,
  textHighlights,
  dimmed,
}: {
  id?: string;
  row: WorktreeRow;
  slot: string | undefined;
  title?: string | undefined;
  presentation?: WorktreeRowPresentation | undefined;
  focused?: boolean | undefined;
  textHighlights?: WorktreeRowTextHighlights | undefined;
  dimmed?: true | undefined;
}): RowGridRowInput {
  const visual = agentVisual(row);
  const visibleFields = presentation ?? worktreeRowVisibleFields(row, title);
  const activity = activityCellForRow(row);
  const input: Parameters<typeof worktreeStyleRowGridInput>[0] = {
    id: id ?? row.id,
    slot,
    marker: visual.marker,
    title: visibleFields.title,
    agent: visibleFields.agent,
    activity: visibleFields.activity,
    activityImportance: activity.importance,
    // Let the status claim the row's trailing slack so it stretches to the end
    // instead of truncating while empty space remains, matching transient rows.
    activityOverflow: "rowSlack",
    metadataGroups: metadataGroups(row),
  };
  if (textHighlights !== undefined) {
    input.textHighlights = textHighlights;
  }
  if (dimmed === true) {
    input.dimmed = true;
  }
  // Tone colors the glyph + status label only — the session name must stay
  // foreground in every state (D12/D13).
  const tone = visual.tone;
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
  textHighlights?: WorktreeRowTextHighlights;
  dimmed?: true;
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
    segments: highlightedTextSegments(input.title, input.color, input.textHighlights?.title ?? []),
    importance: "required",
  };
  if (input.agent !== undefined) {
    cells.agent = {
      key: "agent",
      segments: highlightedTextSegments(
        input.agent,
        input.agentColor ?? input.color,
        input.textHighlights?.agent ?? [],
      ),
      importance: "optional",
    };
  }
  if (input.activity !== undefined) {
    cells.activity = {
      key: "activity",
      segments: highlightedTextSegments(
        input.activity,
        input.activityColor ?? input.color,
        input.textHighlights?.activity ?? [],
      ),
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

  if (input.dimmed === true) {
    for (const cell of Object.values(cells)) {
      if (cell !== undefined) {
        cell.segments = cell.segments.map(dimmedSegment);
      }
    }
  }

  const row: RowGridRowInput = {
    id: input.id,
    cells,
  };
  if (input.metadataGroups !== undefined) {
    row.metadataGroups =
      input.dimmed === true
        ? {
            diff: input.metadataGroups.diff.map(dimmedSegment),
            pr: input.metadataGroups.pr.map(dimmedSegment),
          }
        : input.metadataGroups;
  }
  if (input.color !== undefined) {
    row.color = input.color;
  }
  return row;
}

function highlightedTextSegments(
  text: string,
  color: RowColor | undefined,
  ranges: readonly TextMatchRange[],
): RowSegment[] {
  return textMatchSegments(text, ranges).map((segment) =>
    segment.matched
      ? textSegment(segment.text, { color, highlighted: true })
      : textSegment(segment.text, { color }),
  );
}

function dimmedSegment(segment: RowSegment): RowSegment {
  return { ...segment, dimmed: true };
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
    textSegment(`[${slot ?? " "}] `, { color, role: "selectionSlot" }),
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

export function worktreeRowVisibleFields(
  row: WorktreeRow,
  title?: string,
): WorktreeRowPresentation {
  return {
    title: title ?? row.branch,
    agent: row.agent?.harness ?? "-",
    activity: activityCellForRow(row).text,
  };
}

function activityCellForRow(row: WorktreeRow): {
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

function agentVisual(row: WorktreeRow): AgentVisual {
  return isReadyToRead(row) ? READY_TO_READ_VISUAL : AGENT_VISUALS[row.agent?.state ?? "none"];
}

type MetadataSegment = {
  text: string;
  stale: boolean;
  color?: RowColor;
  underline?: true;
  url?: string;
};

export function metadataSegments(row: WorktreeRow): MetadataSegment[] {
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

function metadataGroups(row: WorktreeRow): WorktreeRowMetadataGroups {
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

function diffMetadataSegmentCount(row: WorktreeRow): number {
  const { changeSummary } = row.worktree;
  if (changeSummary === undefined) {
    return 0;
  }
  let count = 0;
  if (changeSummary.additions > 0) count += 1;
  if (changeSummary.deletions > 0) count += 1;
  return count;
}

function checksStateGlyph(checks: NonNullable<WorktreeRow["worktree"]["checks"]>) {
  if (checks.state === "pass") return "✓";
  if (checks.state === "fail") return failedChecksGlyph(checks.failed);
  if (checks.state === "cancelled") return failedChecksGlyph(checks.cancelled);
  if (checks.state === "running") return "…";
  return "-";
}

function prMetadataColor(pr: NonNullable<WorktreeRow["worktree"]["pr"]>): RowColor {
  return pr.state === "merged" ? "purple" : "blue";
}

function failedChecksGlyph(count: number | undefined): string {
  return count === undefined || count <= 0 ? "x" : `x${count}`;
}

function checksStateColor(
  checks: NonNullable<WorktreeRow["worktree"]["checks"]>,
  pr: NonNullable<WorktreeRow["worktree"]["pr"]>,
): RowColor {
  if (pr.state === "merged" && checks.state === "pass") return "purple";
  if (checks.state === "pass") return "green";
  if (checks.state === "fail" || checks.state === "cancelled") return "red";
  if (checks.state === "running") return "yellow";
  return "gray";
}
