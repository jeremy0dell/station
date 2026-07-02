import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { TuiStore } from "@station/dashboard-core";
import type { StationSnapshot } from "@station/contracts";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { selectActivePaneTree, type PaneNode } from "../state/paneTree.js";
import { selectActivePaneId } from "../state/selectors.js";
import type { StationStore } from "../state/store.js";
import {
  MAIN_PANE_ID,
  projectPaneId,
  worktreeIdFromAgentPaneId,
  worktreePaneId,
  type PaneId,
  type PaneRecord,
  type StationState,
} from "../state/types.js";
import { usePaneRegistry } from "./registry/paneTerminalContext.js";
import type { PtyRegistryView } from "./registry/ptyRegistry.js";
import { PANE_BORDER_ACTIVE, PANE_BORDER_INACTIVE, TerminalPane } from "./TerminalPane.js";
import { STATION_COLORS } from "../station/view/theme.js";

export type PaneGridProps = {
  store: StationStore;
  stationViewStore?: StoreApi<TuiStore>;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  /** Forwarded to every pane so a completed drag/word/line selection is copied. */
  onCopySelection?: (text: string) => void;
};

type RenderCtx = {
  registry: PtyRegistryView;
  store: StationStore;
  activePaneId: PaneId | null;
  workspace: StationState["workspace"];
  snapshot: StationSnapshot | undefined;
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  onCopySelection: ((text: string) => void) | undefined;
};

/**
 * Renders only the active session's tree; sibling sessions are hidden but stay
 * live because the registry, not React, owns PTYs. Keep spawn/dispose out of
 * component lifecycle, since splits and session switches remount panes.
 */
export function PaneGrid({
  store,
  stationViewStore,
  dispatchMouse,
  onCopySelection,
}: PaneGridProps) {
  const registry = usePaneRegistry();
  // Stable getSnapshot identity (store is stable) so useSyncExternalStore rereads only on store notify, not every render.
  const getWorkspace = useCallback(() => store.getState().workspace, [store]);
  const getActivePaneId = useCallback(() => selectActivePaneId(store.getState()), [store]);
  // Slice to `workspace` only—stays Object.is-stable across focus/overlay actions that don't touch panes.
  const workspace = useSyncExternalStore(store.subscribe, getWorkspace, getWorkspace);
  const panes = workspace.panes;
  const activePaneId = useSyncExternalStore(store.subscribe, getActivePaneId, getActivePaneId);
  const snapshot = useStationSnapshot(stationViewStore);
  const tree = useMemo(() => selectActivePaneTree(panes, activePaneId), [panes, activePaneId]);
  if (tree === null) {
    return null;
  }
  return renderNode(tree, {
    registry,
    store,
    activePaneId,
    workspace,
    snapshot,
    dispatchMouse,
    onCopySelection,
  });
}

function renderNode(node: PaneNode, ctx: RenderCtx): ReactNode {
  if (node.kind === "leaf") {
    return <PaneLeaf key={node.paneId} paneId={node.paneId} ctx={ctx} />;
  }
  return (
    <box flexDirection={node.orientation} flexGrow={1}>
      {renderNode(node.first, ctx)}
      {renderNode(node.second, ctx)}
    </box>
  );
}

function PaneLeaf({ paneId, ctx }: { paneId: PaneId; ctx: RenderCtx }): ReactNode {
  const active = paneId === ctx.activePaneId;
  const presentation = panePresentation(paneId, active, ctx);
  // A transparent (no border/padding) mouse-capturing wrapper keeps focus/menu
  // routing per pane while TerminalPane keeps its own 4-cell chrome. Clicking
  // anywhere in the pane focuses it; right-click opens its context menu.
  return (
    <box
      flexGrow={1}
      onMouseDown={(event) => {
        ctx.dispatchMouse({ kind: "pane", paneId }, normalizeStationMouseEvent(event));
      }}
      onMouseScroll={(event) => {
        ctx.dispatchMouse({ kind: "pane", paneId }, normalizeStationMouseEvent(event));
      }}
    >
      <TerminalPane
        paneId={paneId}
        borderColor={presentation.borderColor}
        {...(presentation.title === undefined ? {} : { title: presentation.title })}
        onCopySelection={ctx.onCopySelection}
        onForwardInput={forwardInputFor(ctx, paneId)}
      />
    </box>
  );
}

/**
 * Mouse reports write directly to the PTY so hover/clicks do not snap scrollback
 * to bottom. Block them while overlay input owns the screen.
 */
function forwardInputFor(ctx: RenderCtx, paneId: PaneId): (bytes: string) => void {
  return (bytes: string) => {
    const input = ctx.store.getState().input;
    if (input.activeOverlay !== null) {
      return;
    }
    ctx.registry.write(paneId, bytes);
  };
}

type PaneAccent = {
  active: string;
  inactive: string;
};

const SHELL_ACCENTS: readonly PaneAccent[] = [
  ...STATION_COLORS.chrome.pane.shellAccents,
];

function useStationSnapshot(store: StoreApi<TuiStore> | undefined): StationSnapshot | undefined {
  const subscribe = useCallback(
    (listener: () => void) => (store === undefined ? () => {} : store.subscribe(listener)),
    [store],
  );
  const getSnapshot = useCallback(() => store?.getState().snapshot, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function panePresentation(
  paneId: PaneId,
  active: boolean,
  ctx: Pick<RenderCtx, "workspace" | "snapshot">,
): { borderColor: string; title: string | undefined } {
  const record = paneRecord(ctx.workspace.panes, paneId);
  const title = paneSemanticTitle(paneId, ctx.workspace, ctx.snapshot);
  const accent = paneAccent(paneId, record);
  return { borderColor: active ? accent.active : accent.inactive, title };
}

function paneRecord(panes: readonly PaneRecord[], paneId: PaneId): PaneRecord | undefined {
  return panes.find((candidate) => candidate.id === paneId);
}

function paneAccent(paneId: PaneId, record: PaneRecord | undefined): PaneAccent {
  if (record?.role === "primary-agent" || paneId === MAIN_PANE_ID) {
    return { active: PANE_BORDER_ACTIVE, inactive: PANE_BORDER_INACTIVE };
  }
  // stableIndex returns hash % length, always in range for the fixed array.
  return SHELL_ACCENTS[stableIndex(paneId, SHELL_ACCENTS.length)]!;
}

function stableIndex(value: string, size: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash % size;
}

function paneSemanticTitle(
  paneId: PaneId,
  workspace: StationState["workspace"],
  snapshot: StationSnapshot | undefined,
): string | undefined {
  const primaryAgent = primaryAgentForPane(workspace, paneId);
  if (primaryAgent !== undefined) {
    const row = snapshot?.rows.find((candidate) => candidate.id === primaryAgent.worktreeId);
    const session = snapshot?.sessions.find(
      (candidate) =>
        candidate.id === primaryAgent.sessionId ||
        candidate.worktreeId === primaryAgent.worktreeId,
    );
    const title = session?.title ?? row?.branch ?? primaryAgent.worktreeId;
    const provider = row?.agent?.harness ?? session?.harness.provider;
    return provider === undefined ? `${title} - agent` : `${title} - ${provider} agent`;
  }
  const worktree = snapshot?.rows.find((row) => worktreePaneId(row.id) === paneId);
  if (worktree !== undefined) {
    return `${worktree.branch} - shell`;
  }
  const project = snapshot?.projects.find((candidate) => projectPaneId(candidate.id) === paneId);
  if (project !== undefined) {
    return `${project.label} - shell`;
  }
  return paneId === MAIN_PANE_ID ? "shell" : undefined;
}

function primaryAgentForPane(
  workspace: StationState["workspace"],
  paneId: PaneId,
): { worktreeId: string; sessionId: string } | undefined {
  const pane = workspace.panes.find((candidate) => candidate.id === paneId);
  if (pane?.role !== "primary-agent" || pane.agentIdentity === undefined) {
    return undefined;
  }
  const worktreeId = worktreeIdFromAgentPaneId(paneId);
  return worktreeId === undefined
    ? undefined
    : { worktreeId, sessionId: pane.agentIdentity.sessionId };
}
