import stringWidth from "string-width";

// Semantic only — dashboard-core stays hex-free; view/theme.ts resolves to hex.
export type RowColor = "blue" | "cyan" | "gray" | "green" | "red" | "yellow" | "purple";

export type RowSegment =
  | {
      kind: "text";
      text: string;
      color?: RowColor;
      dimColor?: true;
      underline?: true;
      url?: string;
    }
  | {
      kind: "throbber";
      variant: "braille" | "circle";
      color?: RowColor;
    };

export type RowMarker =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "throbber";
      variant: "braille" | "circle";
    };

export type WorktreeRowMetadataGroup = "diff" | "pr";

export type WorktreeRowMetadataGroups = {
  diff: readonly RowSegment[];
  pr: readonly RowSegment[];
};

export type RowGridCellKey = "identity" | "title" | "agent" | "activity" | "metadata";

export type RowGridColumnSpec = {
  key: RowGridCellKey;
  role: "fixed" | "flex" | "soft" | "right";
  minCells: number;
  idealCells?: number;
  maxCells?: number;
  gapBefore: number;
  dropPriority: number;
  align: "left" | "right";
  truncate: "end" | "clip" | "none";
};

export type RowGridConfig = {
  columns: readonly RowGridColumnSpec[];
};

export type RowGridCellImportance = "required" | "meaningful" | "optional";

type BaseRowGridCell = {
  segments: RowSegment[];
  importance: RowGridCellImportance;
};

export type RowGridCell =
  | (BaseRowGridCell & {
      key: "activity";
      overflow?: "rowSlack";
    })
  | (BaseRowGridCell & {
      key: Exclude<RowGridCellKey, "activity">;
      overflow?: never;
    });

export type RowGridRowInput = {
  id: string;
  cells: Partial<Record<RowGridCellKey, RowGridCell>>;
  metadataGroups?: WorktreeRowMetadataGroups;
  color?: RowColor;
};

export type RowGridLayout = {
  id: string;
  segments: RowSegment[];
  hidden: {
    cells: RowGridCellKey[];
    metadata: WorktreeRowMetadataGroup[];
  };
};

export type WorktreeRowLayout = RowGridLayout;

export type WorktreeRowLayoutInput = {
  columns: number;
  id?: string;
  slot: string | undefined;
  marker: RowMarker;
  title: string;
  harness?: string | undefined;
  statusText?: string | undefined;
  statusSeparator?: string | undefined;
  color?: RowColor | undefined;
  metadata?: WorktreeRowMetadataGroups | undefined;
};

export const DEFAULT_WORKTREE_ROW_GRID: RowGridConfig = {
  columns: [
    {
      key: "identity",
      role: "fixed",
      minCells: 7,
      idealCells: 7,
      maxCells: 7,
      gapBefore: 0,
      dropPriority: 0,
      align: "left",
      truncate: "none",
    },
    {
      key: "title",
      role: "flex",
      minCells: 3,
      idealCells: 22,
      maxCells: 40,
      gapBefore: 0,
      dropPriority: 0,
      align: "left",
      truncate: "end",
    },
    {
      key: "agent",
      role: "soft",
      minCells: 1,
      idealCells: 8,
      maxCells: 10,
      gapBefore: 2,
      // Spec narrowing ladder: agent sheds before the status word (activity).
      dropPriority: 40,
      align: "left",
      truncate: "end",
    },
    {
      key: "activity",
      role: "soft",
      minCells: 4,
      idealCells: 12,
      maxCells: 16,
      gapBefore: 2,
      dropPriority: 30,
      align: "left",
      truncate: "end",
    },
    {
      key: "metadata",
      role: "right",
      minCells: 0,
      gapBefore: 1,
      dropPriority: 20,
      align: "right",
      truncate: "none",
    },
  ],
};

type GraphemeSegment = {
  segment: string;
};

type GraphemeSegmenter = {
  segment(input: string): Iterable<GraphemeSegment>;
};

type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity?: "grapheme" },
) => GraphemeSegmenter;

type MetadataMode = "full" | "compact" | "none";

type MetadataLayout = {
  segments: RowSegment[];
  visibleGroups: WorktreeRowMetadataGroup[];
};

type WidthMode = "desired" | "minimum";

const ROW_GRID_CELL_KEYS: readonly RowGridCellKey[] = [
  "identity",
  "title",
  "agent",
  "activity",
  "metadata",
];
const METADATA_MODES: readonly MetadataMode[] = ["full", "compact", "none"];
const graphemeSegmenter = createGraphemeSegmenter();

export function layoutWorktreeRowGrid(input: {
  columns: number;
  rows: readonly RowGridRowInput[];
  config?: RowGridConfig;
}): RowGridLayout[] {
  const columns = normalizeColumns(input.columns);
  const config = input.config ?? DEFAULT_WORKTREE_ROW_GRID;
  const specs = config.columns;
  const rightSpec = specs.find((spec) => spec.key === "metadata");
  const allLeftColumns = activeLeftColumnSets(config, input.rows);
  const fullLeftSet = allLeftColumns[0] ?? [];

  // Narrowing ladder (spec): keep the jump key, status glyph and session NAME
  // intact, shedding lanes in order — diff, then PR (the metadata modes), then
  // agent, then the status word (soft columns) — before ever truncating the name.
  for (const metadataMode of METADATA_MODES) {
    const metadata = input.rows.map((row) => metadataForMode(row, metadataMode));
    const rightReserve = Math.max(0, ...metadata.map((layout) => segmentsWidth(layout.segments)));
    const rightGap =
      rightReserve > 0 && rightSpec !== undefined ? normalizeCells(rightSpec.gapBefore) : 0;
    const leftBudget = columns - rightReserve - rightGap;
    if (leftBudget < 0) {
      continue;
    }

    // While any metadata remains, hold every left column; only once metadata is
    // gone do we start dropping agent, then the status word.
    const activeSets = metadataMode === "none" ? allLeftColumns : [fullLeftSet];
    const layouts = layoutActiveSets({
      activeSets,
      columns,
      config,
      leftBudget,
      metadata,
      rows: input.rows,
      widthMode: "desired",
      requireFullTitle: true,
    });
    if (layouts !== undefined) {
      return layouts;
    }
  }

  // Last resort: nothing kept the name intact, so truncate the title with
  // metadata gone and soft columns minimized (meaningful ones still protected).
  const noneMetadata = input.rows.map((row) => metadataForMode(row, "none"));
  const protectedKeys = meaningfulSoftColumnKeys(config, input.rows);
  const minimumSets =
    protectedKeys.length === 0
      ? allLeftColumns
      : allLeftColumns
          .filter((keys) => protectedKeys.every((key) => keys.includes(key)))
          .sort((left, right) => left.length - right.length);
  const minimumLayouts = layoutActiveSets({
    activeSets: minimumSets,
    columns,
    config,
    leftBudget: columns,
    metadata: noneMetadata,
    rows: input.rows,
    widthMode: "minimum",
    requireFullTitle: false,
  });
  if (minimumLayouts !== undefined) {
    return minimumLayouts;
  }

  return fallbackLayouts(columns, input.rows);
}

export function layoutWorktreeRow(input: WorktreeRowLayoutInput): WorktreeRowLayout {
  const rowInput = rowGridInputFromRowLayoutInput(input);
  const layout = layoutWorktreeRowGrid({
    columns: input.columns,
    rows: [rowInput],
  })[0];
  if (layout !== undefined) {
    return layout;
  }
  const fallback = fallbackLayouts(normalizeColumns(input.columns), [rowInput])[0];
  if (fallback === undefined) {
    throw new Error("Expected row grid fallback layout.");
  }
  return fallback;
}

export function cellWidth(text: string): number {
  return stringWidth(sanitizeText(text));
}

export function segmentsWidth(segments: readonly RowSegment[]): number {
  return segments.reduce((total, segment) => total + segmentWidth(segment), 0);
}

export function truncateCells(text: string, cells: number): string {
  const normalized = sanitizeText(text);
  const limit = normalizeCells(cells);
  if (limit <= 0) return "";
  if (cellWidth(normalized) <= limit) return normalized;
  const ellipsis = "…";
  const ellipsisWidth = cellWidth(ellipsis);
  if (limit < ellipsisWidth) {
    return clipCells(normalized, limit);
  }
  return `${clipCells(normalized, limit - ellipsisWidth)}${ellipsis}`;
}

export function hardClipSegments(segments: readonly RowSegment[], cells: number): RowSegment[] {
  let remaining = normalizeCells(cells);
  const clipped: RowSegment[] = [];
  for (const segment of segments) {
    if (remaining <= 0) break;
    if (segment.kind === "throbber") {
      clipped.push(segment);
      remaining -= 1;
      continue;
    }
    const width = cellWidth(segment.text);
    if (width <= remaining) {
      clipped.push(segment);
      remaining -= width;
      continue;
    }
    const text = clipCells(segment.text, remaining);
    if (text.length > 0) {
      clipped.push(copyTextSegment(segment, text));
      remaining -= cellWidth(text);
    }
    break;
  }
  return clipped;
}

export function textSegment(
  text: string,
  options: {
    color?: RowColor | undefined;
    dimColor?: true | undefined;
    underline?: true | undefined;
    url?: string | undefined;
  } = {},
): RowSegment {
  const segment: Extract<RowSegment, { kind: "text" }> = {
    kind: "text",
    text: sanitizeText(text),
  };
  if (options.color !== undefined) segment.color = options.color;
  if (options.dimColor === true) segment.dimColor = true;
  if (options.underline === true) segment.underline = true;
  if (options.url !== undefined) segment.url = options.url;
  return segment;
}

function layoutActiveSets(input: {
  activeSets: readonly RowGridCellKey[][];
  columns: number;
  config: RowGridConfig;
  leftBudget: number;
  metadata: readonly MetadataLayout[];
  rows: readonly RowGridRowInput[];
  widthMode: WidthMode;
  requireFullTitle: boolean;
}): RowGridLayout[] | undefined {
  for (const activeKeys of input.activeSets) {
    const widths = assignLeftWidths({
      activeKeys,
      config: input.config,
      leftBudget: input.leftBudget,
      rows: input.rows,
      widthMode: input.widthMode,
      requireFullTitle: input.requireFullTitle,
    });
    if (widths === undefined) {
      continue;
    }
    return input.rows.map((row, index) =>
      renderGridRow({
        activeKeys,
        columns: input.columns,
        config: input.config,
        metadata: input.metadata[index] ?? emptyMetadataLayout(),
        row,
        widths,
      }),
    );
  }
  return undefined;
}

function activeLeftColumnSets(
  config: RowGridConfig,
  rows: readonly RowGridRowInput[],
): RowGridCellKey[][] {
  const leftSpecs = config.columns.filter((spec) => spec.role !== "right");
  const requiredKeys = leftSpecs
    .filter((spec) => spec.role === "fixed" || spec.role === "flex")
    .map((spec) => spec.key);
  const droppableKeys = leftSpecs
    .filter((spec) => spec.role === "soft")
    .filter((spec) => rows.some((row) => row.cells[spec.key] !== undefined))
    .map((spec) => spec.key)
    .sort((left, right) => compareDropOrder(config, rows, left, right));
  const sets: RowGridCellKey[][] = [];
  let active = sortKeysByConfig(config, [...requiredKeys, ...droppableKeys]);
  sets.push(active);
  for (const key of droppableKeys) {
    active = active.filter((candidate) => candidate !== key);
    sets.push(sortKeysByConfig(config, active));
  }
  return dedupeKeySets(sets);
}

function meaningfulSoftColumnKeys(
  config: RowGridConfig,
  rows: readonly RowGridRowInput[],
): RowGridCellKey[] {
  return config.columns
    .filter((spec) => spec.role === "soft")
    .filter((spec) => columnImportance(rows, spec.key) === "meaningful")
    .map((spec) => spec.key);
}

function compareDropOrder(
  config: RowGridConfig,
  rows: readonly RowGridRowInput[],
  left: RowGridCellKey,
  right: RowGridCellKey,
): number {
  const importanceDelta =
    importanceRank(columnImportance(rows, left)) - importanceRank(columnImportance(rows, right));
  if (importanceDelta !== 0) return importanceDelta;
  const leftSpec = requiredSpec(config, left);
  const rightSpec = requiredSpec(config, right);
  const priorityDelta = rightSpec.dropPriority - leftSpec.dropPriority;
  if (priorityDelta !== 0) return priorityDelta;
  return specIndex(config, left) - specIndex(config, right);
}

function assignLeftWidths(input: {
  activeKeys: readonly RowGridCellKey[];
  config: RowGridConfig;
  leftBudget: number;
  rows: readonly RowGridRowInput[];
  widthMode: WidthMode;
  requireFullTitle: boolean;
}): Map<RowGridCellKey, number> | undefined {
  const activeSpecs = sortKeysByConfig(input.config, [...input.activeKeys]).map((key) =>
    requiredSpec(input.config, key),
  );
  const widths = new Map<RowGridCellKey, number>();
  let nonFlexWidth = 0;
  const flexSpecs: RowGridColumnSpec[] = [];

  for (const spec of activeSpecs) {
    nonFlexWidth += normalizeCells(spec.gapBefore);
    if (spec.role === "fixed") {
      const width = fixedColumnWidth(spec);
      widths.set(spec.key, width);
      nonFlexWidth += width;
      continue;
    }
    if (spec.role === "soft") {
      const width =
        input.widthMode === "desired"
          ? desiredSoftColumnWidth(spec, input.rows)
          : normalizeCells(spec.minCells);
      widths.set(spec.key, width);
      nonFlexWidth += width;
      continue;
    }
    if (spec.role === "flex") {
      flexSpecs.push(spec);
    }
  }

  const flexGapWidth = flexSpecs.reduce((total, spec) => total + normalizeCells(spec.gapBefore), 0);
  let remaining = input.leftBudget - nonFlexWidth - flexGapWidth;
  if (remaining < 0) {
    return undefined;
  }

  for (const [index, spec] of flexSpecs.entries()) {
    const laterMin = flexSpecs
      .slice(index + 1)
      .reduce((total, later) => total + normalizeCells(later.minCells), 0);
    const available = remaining - laterMin;
    const min = normalizeCells(spec.minCells);
    if (available < min) {
      return undefined;
    }
    // Title priority: fail (so an upstream lane sheds) rather than truncate the name.
    if (input.requireFullTitle && available < flexDesiredWidth(spec, input.rows)) {
      return undefined;
    }
    const max = spec.maxCells === undefined ? available : normalizeCells(spec.maxCells);
    const width = Math.min(max, Math.max(min, available));
    widths.set(spec.key, width);
    remaining -= width;
  }

  return widths;
}

function renderGridRow(input: {
  activeKeys: readonly RowGridCellKey[];
  columns: number;
  config: RowGridConfig;
  metadata: MetadataLayout;
  row: RowGridRowInput;
  widths: ReadonlyMap<RowGridCellKey, number>;
}): RowGridLayout {
  const activeSet = new Set(input.activeKeys);
  const segments: RowSegment[] = [];
  const activeKeys = sortKeysByConfig(input.config, [...input.activeKeys]);
  const metadataWidth = segmentsWidth(input.metadata.segments);
  for (const [index, key] of activeKeys.entries()) {
    const spec = requiredSpec(input.config, key);
    const gap = normalizeCells(spec.gapBefore);
    if (gap > 0) segments.push(textSegment(" ".repeat(gap)));
    const width = renderWidthForCell({
      activeKeys,
      cell: input.row.cells[key],
      columns: input.columns,
      config: input.config,
      index,
      key,
      metadataWidth,
      segments,
      sharedWidth: input.widths.get(key) ?? 0,
      widths: input.widths,
    });
    segments.push(...renderCell(input.row.cells[key], spec, width));
  }

  if (metadataWidth > 0) {
    const spacerCells = Math.max(1, input.columns - segmentsWidth(segments) - metadataWidth);
    segments.push(textSegment(" ".repeat(spacerCells)));
    segments.push(...input.metadata.segments);
  }

  return {
    id: input.row.id,
    segments,
    hidden: {
      cells: hiddenCells(input.row, activeSet),
      metadata: hiddenMetadata(metadataGroups(input.row), input.metadata.visibleGroups),
    },
  };
}

function renderWidthForCell(input: {
  activeKeys: readonly RowGridCellKey[];
  cell: RowGridCell | undefined;
  columns: number;
  config: RowGridConfig;
  index: number;
  key: RowGridCellKey;
  metadataWidth: number;
  segments: readonly RowSegment[];
  sharedWidth: number;
  widths: ReadonlyMap<RowGridCellKey, number>;
}): number {
  const sharedWidth = normalizeCells(input.sharedWidth);
  if (input.key !== "activity" || input.cell?.overflow !== "rowSlack") {
    return sharedWidth;
  }

  const tailWidth = remainingLeftColumnWidth({
    activeKeys: input.activeKeys,
    config: input.config,
    index: input.index,
    widths: input.widths,
  });
  const metadataGap = input.metadataWidth > 0 ? 1 : 0;
  const available =
    input.columns - segmentsWidth(input.segments) - tailWidth - metadataGap - input.metadataWidth;
  return Math.max(sharedWidth, normalizeCells(available));
}

function remainingLeftColumnWidth(input: {
  activeKeys: readonly RowGridCellKey[];
  config: RowGridConfig;
  index: number;
  widths: ReadonlyMap<RowGridCellKey, number>;
}): number {
  return input.activeKeys.slice(input.index + 1).reduce((total, key) => {
    const spec = requiredSpec(input.config, key);
    return total + normalizeCells(spec.gapBefore) + normalizeCells(input.widths.get(key) ?? 0);
  }, 0);
}

function renderCell(
  cell: RowGridCell | undefined,
  spec: RowGridColumnSpec,
  width: number,
): RowSegment[] {
  const normalizedWidth = normalizeCells(width);
  if (normalizedWidth <= 0) {
    return [];
  }
  if (cell === undefined) {
    return [textSegment(" ".repeat(normalizedWidth))];
  }
  const fitted = fitCellSegments(cell.segments, spec, normalizedWidth);
  const fittedWidth = segmentsWidth(fitted);
  const padCells = Math.max(0, normalizedWidth - fittedWidth);
  if (padCells === 0) {
    return fitted;
  }
  const padding = textSegment(" ".repeat(padCells));
  return spec.align === "right" ? [padding, ...fitted] : [...fitted, padding];
}

function fitCellSegments(
  segments: readonly RowSegment[],
  spec: RowGridColumnSpec,
  width: number,
): RowSegment[] {
  if (segmentsWidth(segments) <= width) {
    return [...segments];
  }
  if (spec.truncate === "clip" || spec.truncate === "none") {
    return hardClipSegments(segments, width);
  }
  return truncateSegmentsEnd(segments, width);
}

function truncateSegmentsEnd(segments: readonly RowSegment[], width: number): RowSegment[] {
  const normalizedWidth = normalizeCells(width);
  if (normalizedWidth <= 0) return [];
  const ellipsis = textSegment("…", textStyleFromSegments(segments));
  const ellipsisWidth = segmentsWidth([ellipsis]);
  if (normalizedWidth < ellipsisWidth) {
    return hardClipSegments(segments, normalizedWidth);
  }
  return [...hardClipSegments(segments, normalizedWidth - ellipsisWidth), ellipsis];
}

function fallbackLayouts(columns: number, rows: readonly RowGridRowInput[]): RowGridLayout[] {
  return rows.map((row) => {
    const identity = row.cells.identity?.segments ?? [];
    const title = row.cells.title?.segments ?? [];
    return {
      id: row.id,
      segments: hardClipSegments([...identity, ...title], columns),
      hidden: {
        cells: hiddenCells(row, new Set(["identity", "title"])),
        metadata: hiddenMetadata(metadataGroups(row), []),
      },
    };
  });
}

function metadataForMode(row: RowGridRowInput, mode: MetadataMode): MetadataLayout {
  const groups = metadataGroups(row);
  if (mode === "none") {
    return emptyMetadataLayout();
  }
  if (mode === "compact") {
    if (groups.pr.length === 0) {
      return emptyMetadataLayout();
    }
    return {
      segments: joinSegmentsWithSpaces(groups.pr),
      visibleGroups: ["pr"],
    };
  }
  const visibleGroups: WorktreeRowMetadataGroup[] = [];
  if (groups.diff.length > 0) visibleGroups.push("diff");
  if (groups.pr.length > 0) visibleGroups.push("pr");
  return {
    segments: joinSegmentsWithSpaces([...groups.diff, ...groups.pr]),
    visibleGroups,
  };
}

function metadataGroups(row: RowGridRowInput): WorktreeRowMetadataGroups {
  if (row.metadataGroups !== undefined) {
    return row.metadataGroups;
  }
  const metadataCell = row.cells.metadata;
  if (metadataCell === undefined) {
    return emptyMetadataGroups();
  }
  return {
    diff: [],
    pr: metadataCell.segments,
  };
}

function hiddenCells(
  row: RowGridRowInput,
  activeSet: ReadonlySet<RowGridCellKey>,
): RowGridCellKey[] {
  return ROW_GRID_CELL_KEYS.filter(
    (key) => key !== "metadata" && row.cells[key] !== undefined && !activeSet.has(key),
  );
}

function hiddenMetadata(
  metadata: WorktreeRowMetadataGroups,
  visibleGroups: readonly WorktreeRowMetadataGroup[],
): WorktreeRowMetadataGroup[] {
  const visible = new Set(visibleGroups);
  const hidden: WorktreeRowMetadataGroup[] = [];
  if (metadata.diff.length > 0 && !visible.has("diff")) {
    hidden.push("diff");
  }
  if (metadata.pr.length > 0 && !visible.has("pr")) {
    hidden.push("pr");
  }
  return hidden;
}

function joinSegmentsWithSpaces(segments: readonly RowSegment[]): RowSegment[] {
  const joined: RowSegment[] = [];
  segments.forEach((segment, index) => {
    if (index > 0) {
      joined.push(textSegment(" "));
    }
    joined.push(segment);
  });
  return joined;
}

function rowGridInputFromRowLayoutInput(input: WorktreeRowLayoutInput): RowGridRowInput {
  const cells: Partial<Record<RowGridCellKey, RowGridCell>> = {};
  cells.identity = {
    key: "identity",
    segments: identitySegments(input.slot, input.marker, input.color),
    importance: "required",
  };
  cells.title = {
    key: "title",
    segments: [textSegment(input.title, { color: input.color })],
    importance: "required",
  };
  if (input.harness !== undefined) {
    cells.agent = {
      key: "agent",
      segments: [textSegment(input.harness, { color: input.color })],
      importance: "optional",
    };
  }
  if (input.statusText !== undefined) {
    cells.activity = {
      key: "activity",
      segments: [textSegment(input.statusText, { color: input.color })],
      importance: "meaningful",
    };
  }
  const row: RowGridRowInput = {
    id: input.id ?? "row",
    cells,
  };
  if (input.metadata !== undefined) {
    row.metadataGroups = input.metadata;
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
): RowSegment[] {
  const segments: RowSegment[] = [textSegment(` [${slot ?? " "}] `, { color })];
  if (marker.kind === "throbber") {
    segments.push({ kind: "throbber", variant: marker.variant });
  } else {
    segments.push(textSegment(marker.text, { color }));
  }
  segments.push(textSegment(" ", { color }));
  return segments;
}

function columnImportance(
  rows: readonly RowGridRowInput[],
  key: RowGridCellKey,
): RowGridCellImportance {
  let importance: RowGridCellImportance = "optional";
  for (const row of rows) {
    const cell = row.cells[key];
    if (cell === undefined) {
      continue;
    }
    if (cell.importance === "required") {
      return "required";
    }
    if (cell.importance === "meaningful") {
      importance = "meaningful";
    }
  }
  return importance;
}

function importanceRank(importance: RowGridCellImportance): number {
  if (importance === "required") return 2;
  if (importance === "meaningful") return 1;
  return 0;
}

function desiredSoftColumnWidth(spec: RowGridColumnSpec, rows: readonly RowGridRowInput[]): number {
  const maxVisible = Math.max(
    0,
    ...rows.map((row) => segmentsWidth(row.cells[spec.key]?.segments ?? [])),
  );
  const ideal = spec.idealCells ?? spec.minCells;
  const desired = Math.max(normalizeCells(spec.minCells), normalizeCells(ideal), maxVisible);
  if (spec.maxCells === undefined) {
    return desired;
  }
  return Math.min(desired, normalizeCells(spec.maxCells));
}

// Width the flex title needs to show its content untruncated (clamped to the
// column's min/max). Used to keep the name intact until droppable lanes shed.
function flexDesiredWidth(spec: RowGridColumnSpec, rows: readonly RowGridRowInput[]): number {
  const content = Math.max(
    0,
    ...rows.map((row) => segmentsWidth(row.cells[spec.key]?.segments ?? [])),
  );
  const min = normalizeCells(spec.minCells);
  const max = spec.maxCells === undefined ? content : normalizeCells(spec.maxCells);
  return Math.min(max, Math.max(min, content));
}

function fixedColumnWidth(spec: RowGridColumnSpec): number {
  return normalizeCells(spec.idealCells ?? spec.maxCells ?? spec.minCells);
}

function requiredSpec(config: RowGridConfig, key: RowGridCellKey): RowGridColumnSpec {
  const spec = config.columns.find((candidate) => candidate.key === key);
  if (spec === undefined) {
    throw new Error(`Missing row grid column spec for ${key}.`);
  }
  return spec;
}

function specIndex(config: RowGridConfig, key: RowGridCellKey): number {
  const index = config.columns.findIndex((spec) => spec.key === key);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sortKeysByConfig(config: RowGridConfig, keys: RowGridCellKey[]): RowGridCellKey[] {
  return keys.sort((left, right) => specIndex(config, left) - specIndex(config, right));
}

function dedupeKeySets(sets: readonly RowGridCellKey[][]): RowGridCellKey[][] {
  const seen = new Set<string>();
  const deduped: RowGridCellKey[][] = [];
  for (const set of sets) {
    const key = set.join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(set);
  }
  return deduped;
}

function textStyleFromSegments(segments: readonly RowSegment[]): {
  color?: RowColor | undefined;
  dimColor?: true | undefined;
  underline?: true | undefined;
  url?: string | undefined;
} {
  const text = [...segments].reverse().find((segment) => segment.kind === "text");
  if (text === undefined || text.kind !== "text") {
    return {};
  }
  const style: {
    color?: RowColor;
    dimColor?: true;
    underline?: true;
    url?: string;
  } = {};
  if (text.color !== undefined) style.color = text.color;
  if (text.dimColor === true) style.dimColor = true;
  if (text.underline === true) style.underline = true;
  if (text.url !== undefined) style.url = text.url;
  return style;
}

function segmentWidth(segment: RowSegment): number {
  return segment.kind === "throbber" ? 1 : cellWidth(segment.text);
}

function clipCells(text: string, cells: number): string {
  let remaining = normalizeCells(cells);
  let clipped = "";
  for (const grapheme of graphemes(text)) {
    if (remaining <= 0) break;
    const width = cellWidth(grapheme);
    if (width > remaining) break;
    clipped += grapheme;
    remaining -= width;
  }
  return clipped;
}

function graphemes(text: string): string[] {
  const normalized = sanitizeText(text);
  if (graphemeSegmenter === undefined) {
    return Array.from(normalized);
  }
  return Array.from(graphemeSegmenter.segment(normalized), (segment) => segment.segment);
}

function copyTextSegment(segment: Extract<RowSegment, { kind: "text" }>, text: string): RowSegment {
  const copied: Extract<RowSegment, { kind: "text" }> = {
    kind: "text",
    text: sanitizeText(text),
  };
  if (segment.color !== undefined) copied.color = segment.color;
  if (segment.dimColor === true) copied.dimColor = true;
  if (segment.underline === true) copied.underline = true;
  if (segment.url !== undefined) copied.url = segment.url;
  return copied;
}

function sanitizeText(text: string): string {
  return text.replace(/[\t\n\r]+/g, " ");
}

function normalizeColumns(columns: number): number {
  return Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
}

function normalizeCells(cells: number): number {
  return Math.max(0, Math.floor(Number.isFinite(cells) ? cells : 0));
}

function emptyMetadataGroups(): WorktreeRowMetadataGroups {
  return {
    diff: [],
    pr: [],
  };
}

function emptyMetadataLayout(): MetadataLayout {
  return {
    segments: [],
    visibleGroups: [],
  };
}

function createGraphemeSegmenter(): GraphemeSegmenter | undefined {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  return Segmenter === undefined
    ? undefined
    : new Segmenter(undefined, { granularity: "grapheme" });
}
