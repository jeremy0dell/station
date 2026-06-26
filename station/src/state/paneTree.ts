import type { PaneId, PaneRecord } from "./types.js";

/**
 * Read-side render tree derived from flat pane records, not stored separately.
 * Rebuilding from records keeps close/split changes from leaving a stale layout.
 * `"row"` is left/right; `"column"` is top/bottom.
 */
export type PaneNodeOrientation = "row" | "column";

export type PaneNode =
  | { kind: "leaf"; paneId: PaneId }
  | {
      kind: "split";
      orientation: PaneNodeOrientation;
      first: PaneNode;
      second: PaneNode;
    };

/**
 * Fold records into one root per session work area. Do not merge roots: the
 * renderer shows only the active session full-screen. Splits replace anchor
 * leaves, so repeated splits intentionally nest rather than equalize.
 */
export function buildPaneForest(panes: readonly PaneRecord[]): PaneNode[] {
  const roots: PaneNode[] = [];
  for (const record of panes) {
    const leaf: PaneNode = { kind: "leaf", paneId: record.id };
    if (record.split === null) {
      roots.push(leaf);
      continue;
    }
    const orientation: PaneNodeOrientation = record.split.direction === "right" ? "row" : "column";
    const anchorId = record.split.anchorPaneId;
    const rootIndex = roots.findIndex((root) => containsPane(root, anchorId));
    const root = rootIndex === -1 ? undefined : roots[rootIndex];
    // A missing anchor cannot happen through the store (create validates the
    // anchor; close clears split metadata pointing at a removed pane), but a
    // defensive new root keeps the pane visible rather than dropping it.
    if (root === undefined) {
      roots.push(leaf);
      continue;
    }
    roots[rootIndex] = replaceLeaf(root, anchorId, (anchor) => ({
      kind: "split",
      orientation,
      first: anchor,
      second: leaf,
    })) ?? root;
  }
  return roots;
}

/**
 * Render only the active session tree; sibling trees are hidden, not killed,
 * because PtyRegistry owns live PTYs. Empty workspace is the only `null`.
 */
export function selectActivePaneTree(
  panes: readonly PaneRecord[],
  activePaneId: PaneId | null,
): PaneNode | null {
  const forest = buildPaneForest(panes);
  if (activePaneId !== null) {
    const active = forest.find((root) => containsPane(root, activePaneId));
    if (active !== undefined) {
      return active;
    }
  }
  return forest[0] ?? null;
}

/**
 * The pane ids sharing a forest tree (one session's work area) with `paneId`,
 * including it. Empty when the pane is absent. Lets `closePane` retarget focus
 * to a survivor in the closed pane's own tree rather than another worktree's.
 */
export function paneTreeIds(
  panes: readonly PaneRecord[],
  paneId: PaneId,
): ReadonlySet<PaneId> {
  const ids = new Set<PaneId>();
  const tree = buildPaneForest(panes).find((root) => containsPane(root, paneId));
  if (tree !== undefined) {
    collectLeafIds(tree, ids);
  }
  return ids;
}

function collectLeafIds(node: PaneNode, into: Set<PaneId>): void {
  if (node.kind === "leaf") {
    into.add(node.paneId);
    return;
  }
  collectLeafIds(node.first, into);
  collectLeafIds(node.second, into);
}

function containsPane(node: PaneNode, paneId: PaneId): boolean {
  if (node.kind === "leaf") {
    return node.paneId === paneId;
  }
  return containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

/**
 * Return a copy of `node` with the leaf matching `paneId` replaced, or `null`
 * when the leaf is not in this subtree (so callers can detect a missing anchor).
 */
function replaceLeaf(
  node: PaneNode,
  paneId: PaneId,
  replacer: (leaf: Extract<PaneNode, { kind: "leaf" }>) => PaneNode,
): PaneNode | null {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? replacer(node) : null;
  }
  const inFirst = replaceLeaf(node.first, paneId, replacer);
  if (inFirst !== null) {
    return { ...node, first: inFirst };
  }
  const inSecond = replaceLeaf(node.second, paneId, replacer);
  if (inSecond !== null) {
    return { ...node, second: inSecond };
  }
  return null;
}
