import type { WorktreeRow as WorktreeRowModel } from "@station/contracts";
import {
  type MetadataAtom,
  worktreeMetadataAtoms,
  worktreeStatusAtom,
} from "../../tokens/status.js";
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
}: {
  id?: string;
  row: WorktreeRowModel;
  slot: string | undefined;
  title?: string | undefined;
}): RowGridRowInput {
  const status = worktreeStatusAtom(row);
  const displayTitle = title ?? row.branch;
  const input: Parameters<typeof worktreeStyleRowGridInput>[0] = {
    id: id ?? row.id,
    slot,
    marker: status.marker,
    title: displayTitle,
    agent: row.agent?.harness ?? "-",
    activity: status.activity,
    activityImportance: status.activityImportance,
    // Let the status claim the row's trailing slack so it stretches to the end
    // instead of truncating while empty space remains, matching transient rows.
    activityOverflow: "rowSlack",
    metadataGroups: metadataGroups(row),
  };
  if (status.markerColor !== undefined) {
    input.markerColor = status.markerColor;
  }
  if (status.activityColor !== undefined) {
    input.activityColor = status.activityColor;
  }
  return status.rowColor === undefined
    ? worktreeStyleRowGridInput(input)
    : worktreeStyleRowGridInput({
        ...input,
        color: status.rowColor,
      });
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
  metadataGroups?: WorktreeRowMetadataGroups;
}): RowGridRowInput {
  const cells: Partial<Record<RowGridCellKey, RowGridCell>> = {};
  cells.identity = {
    key: "identity",
    segments: identitySegments(input.slot, input.marker, input.color, input.markerColor),
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
      segments: [textSegment(input.agent, { color: input.color })],
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
): RowSegment[] {
  const segments: RowSegment[] = [textSegment(` [${slot ?? " "}] `, { color })];
  if (marker.kind === "throbber") {
    segments.push({ kind: "throbber", variant: marker.variant });
  } else {
    segments.push(textSegment(marker.text, { color: markerColor ?? color }));
  }
  segments.push(textSegment(" ", { color }));
  return segments;
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
  return worktreeMetadataAtoms(row).map(metadataSegmentFromAtom);
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

function metadataSegmentFromAtom(atom: MetadataAtom): MetadataSegment {
  const segment: MetadataSegment = {
    text: atom.text,
    stale: atom.stale,
  };
  if (atom.color !== undefined) segment.color = atom.color;
  if (atom.underline === true) segment.underline = true;
  if (atom.url !== undefined) segment.url = atom.url;
  return segment;
}

function diffMetadataSegmentCount(row: WorktreeRowModel): number {
  return worktreeMetadataAtoms(row).filter((atom) => atom.group === "diff").length;
}
