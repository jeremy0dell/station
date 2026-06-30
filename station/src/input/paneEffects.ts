import type { AuxShellPlacement } from "../terminal/pty/auxShellPlacement.js";
import { buildWheelForwardSequence } from "../terminal/input/wheelForward.js";
import { MouseEncoding } from "../terminal/protocol/mouse.js";
import type { PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import type { StationTerminalSpawnOptions } from "../terminal/types.js";
import type { StoreApi } from "zustand/vanilla";
import { selectPaneRecord } from "../state/selectors.js";
import type { CreatePaneOptions, StationStore } from "../state/store.js";
import {
  agentWorktreePaneId,
  worktreePaneId,
  type PaneId,
  type PaneRole,
  type PaneSplitDirection,
} from "../state/types.js";
import type { Automation } from "../config/stationConfig.js";
import type { TuiStore } from "@station/dashboard-core";
import type { WorktreeRow } from "@station/contracts";
import { paneInputBytes } from "./sequenceNormalize.js";
import type { OpenPaneSpawn } from "./stationInput.js";

/** Lines of scrollback per wheel tick, and arrow repeats per tick when a
 * fullscreen pager owns the screen. Not yet configurable. */
const WHEEL_LINES = 3;

const SPLIT_PANE_ID_PREFIX = "pane-split-";

/**
 * How long an automation waits for a freshly split pane's PTY to spawn (it does
 * so lazily on first layout/resize) before giving up on sending its command, so
 * a pane that is never laid out doesn't leak a registry subscription.
 */
const AUTOMATION_SEND_TIMEOUT_MS = 10_000;

/**
 * Resume split numbering from live panes so restored/HMR-surviving split ids are
 * never reused and silently dropped as duplicates.
 */
export function nextSplitSeqFromPanes(panes: readonly { id: PaneId }[]): number {
  let max = -1;
  for (const pane of panes) {
    if (!pane.id.startsWith(SPLIT_PANE_ID_PREFIX)) {
      continue;
    }
    // Digits only: `Number("")` / `Number(" ")` are 0, so a bare `pane-split-`
    // (reachable from hand-edited disk JSON) would otherwise raise max to 0.
    const suffix = pane.id.slice(SPLIT_PANE_ID_PREFIX.length);
    if (!/^\d+$/.test(suffix)) {
      continue;
    }
    const n = Number(suffix);
    if (n > max) {
      max = n;
    }
  }
  return max + 1;
}

export type PaneEffects = {
  writeToTerminal(paneId: PaneId, bytes: string): boolean;
  pasteToTerminal(paneId: PaneId, text: string): boolean;
  scrollTerminal(paneId: PaneId, direction: "up" | "down"): boolean;
  openPane(paneId: PaneId, spawn: OpenPaneSpawn): void;
  splitPane(anchorPaneId: PaneId, direction: PaneSplitDirection): void;
  runAutomation(automationId: string, anchorPaneId: PaneId): void;
  closePane(paneId: PaneId): void;
};

type PaneEffectsDeps = {
  store: StationStore;
  stationViewStore: StoreApi<TuiStore> | undefined;
  registry: PtyRegistry | undefined;
  resolveAuxShellPlacement: AuxShellPlacement | undefined;
  autoCloseOverlay: boolean;
  automations: readonly Automation[];
  writeToTerminal: ((paneId: PaneId, bytes: string) => boolean) | undefined;
  pasteToTerminal: ((paneId: PaneId, text: string) => boolean) | undefined;
};

export function createPaneEffects(deps: PaneEffectsDeps): PaneEffects {
  const { store, stationViewStore, registry, resolveAuxShellPlacement, autoCloseOverlay, automations } =
    deps;
  // Monotonic split-id source, seeded above any existing split id so restored / HMR-surviving
  // splits keep theirs and a fresh split can't collide with one already in the store.
  let splitSeq = nextSplitSeqFromPanes(store.getState().workspace.panes);

  const writeToTerminal =
    deps.writeToTerminal ??
    ((paneId: PaneId, bytes: string) => {
      registry?.get(paneId)?.screen?.scrollToBottom();
      return registry?.write(paneId, paneInputBytes(bytes, registry, paneId)) ?? false;
    });

  const pasteToTerminal =
    deps.pasteToTerminal ??
    ((paneId: PaneId, text: string) => {
      registry?.get(paneId)?.screen?.scrollToBottom();
      return registry?.paste(paneId, text) ?? false;
    });

  function scrollTerminal(paneId: PaneId, direction: "up" | "down"): boolean {
    const screen = registry?.get(paneId)?.screen;
    if (!screen) {
      return false;
    }
    // Alt-screen / mouse-reporting app owns the wheel: forward it as input so the app scrolls
    // natively. Uses registry.write, not writeToTerminal, so it doesn't trip snap-to-bottom.
    if (screen.isAltScreen() || screen.isMouseReportingEnabled()) {
      const stats = screen.bufferStats();
      const bytes = buildWheelForwardSequence({
        direction,
        mouseReporting: screen.isMouseReportingEnabled(),
        encoding: screen.mouseProtocol()?.encoding ?? MouseEncoding.Legacy,
        applicationCursorKeys: screen.isApplicationCursorKeys(),
        cols: stats.cols,
        rows: stats.rows,
        lines: WHEEL_LINES,
      });
      return registry?.write(paneId, bytes) ?? false;
    }
    // Normal buffer: scroll our own scrollback. Up = back into history.
    return screen.scrollBy(direction === "up" ? WHEEL_LINES : -WHEEL_LINES);
  }

  function shellSplitForWorktree(
    spawn: OpenPaneSpawn,
    role: PaneRole,
  ): { anchorPaneId: PaneId; direction: PaneSplitDirection } | undefined {
    if (role !== "shell" || spawn.worktreeId === undefined) {
      return undefined;
    }
    const agentPaneId = agentWorktreePaneId(spawn.worktreeId);
    if (selectPaneRecord(store.getState(), agentPaneId) === null) {
      return undefined;
    }
    return { anchorPaneId: agentPaneId, direction: "right" };
  }

  // Fallback anchor for a shell with no worktree agent: prefer the active pane, else the first
  // record (it roots the on-screen tree). Only a truly empty workspace has nothing to tile against.
  function activeShellSplit(
    role: PaneRole,
  ): { anchorPaneId: PaneId; direction: PaneSplitDirection } | undefined {
    if (role !== "shell") {
      return undefined;
    }
    const { panes, activePaneId } = store.getState().workspace;
    const anchorPaneId = activePaneId ?? panes[0]?.id;
    if (anchorPaneId === undefined) {
      return undefined;
    }
    return { anchorPaneId, direction: "right" };
  }

  function splitCwdForAnchor(anchorPaneId: PaneId): string | undefined {
    const rows = stationViewStore?.getState().snapshot?.rows;
    if (rows === undefined) {
      return undefined;
    }
    const worktreeId = worktreeIdForPane(anchorPaneId, rows);
    return rows.find((row) => row.id === worktreeId)?.path;
  }

  // The split anchor chain is acyclic by construction (createPane validates the anchor already
  // exists; closePane only clears anchors), so this walk to the worktree-owning pane terminates.
  function worktreeIdForPane(paneId: PaneId, rows: readonly WorktreeRow[], depth = 0): string | undefined {
    // Depth guard: disk-restored panes are read here, so cap the walk rather than trust the
    // acyclic invariant absolutely.
    if (depth > rows.length + 1) {
      return undefined;
    }
    for (const row of rows) {
      if (agentWorktreePaneId(row.id) === paneId || worktreePaneId(row.id) === paneId) {
        return row.id;
      }
    }
    const pane = store.getState().workspace.panes.find((candidate) => candidate.id === paneId);
    if (pane?.split === null || pane?.split === undefined) {
      return undefined;
    }
    return worktreeIdForPane(pane.split.anchorPaneId, rows, depth + 1);
  }

  // A split pane's PTY spawns lazily on its first layout/resize, so its terminal is null right after
  // createPane. Send the command on the registry's spawn notify, then stop listening; a safety
  // timeout drops the subscription if the pane is never laid out (or is closed) before it spawns.
  function sendWhenReady(paneId: PaneId, payload: string): void {
    const reg = registry;
    if (payload.length === 0 || reg === undefined) {
      return;
    }
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      unsubscribe?.();
    };
    const attempt = (): void => {
      const entry = reg.get(paneId);
      if (entry === undefined || entry.exited) {
        finish();
        return;
      }
      if (entry.terminal !== null) {
        writeToTerminal(paneId, payload);
        finish();
      }
    };
    attempt();
    if (settled) {
      return;
    }
    unsubscribe = reg.subscribe(attempt);
    timer = setTimeout(finish, AUTOMATION_SEND_TIMEOUT_MS);
  }

  // Open-or-focus a `[+sh]` shell pane with a stable id. On first open, seed the registry entry
  // with the cwd *before* createPane: PtyRegistry.ensure stores spawnOptions only when it first
  // creates the entry, and the pane reconciler's later no-option ensure(paneId) is then an
  // idempotent no-op that preserves them. Reverse the order and the spawn options are silently lost.
  function openPane(paneId: PaneId, spawn: OpenPaneSpawn): void {
    const { cwd, command, args } = spawn;
    const role = spawn.role ?? "shell";
    if (selectPaneRecord(store.getState(), paneId) !== null) {
      store.actions.revealPane(paneId);
    } else {
      const spawnOptions: StationTerminalSpawnOptions = { cwd };
      if (command !== undefined) {
        spawnOptions.command = command;
      }
      if (args !== undefined) {
        spawnOptions.args = args;
      }
      // A plain shell (no explicit command) lands in the host when the daemon is up so it
      // persists across a restart; a pane carrying its own command stays local.
      const createTerminal =
        command === undefined && role === "shell" ? resolveAuxShellPlacement?.(paneId) : undefined;
      registry?.ensure(paneId, spawnOptions, createTerminal);
      const createOptions: CreatePaneOptions = { role };
      // Tile the shell beside the worktree's agent pane when it exists, else split off the active
      // pane; rooting its own session stacked a full-screen pane over the current one.
      const split = shellSplitForWorktree(spawn, role) ?? activeShellSplit(role);
      if (split !== undefined) {
        createOptions.split = split;
      }
      store.actions.createPane(paneId, createOptions);
    }
    if (autoCloseOverlay || role === "primary-agent") {
      store.actions.closeOverlay();
    }
  }

  function splitPane(anchorPaneId: PaneId, direction: PaneSplitDirection): void {
    const newId: PaneId = `${SPLIT_PANE_ID_PREFIX}${splitSeq++}`;
    // Inherit the anchor's live spawn cwd (goes stale once that shell cd's), falling back to its
    // worktree path. Threaded only when present so an undefined cwd stays absent.
    const cwd = registry?.get(anchorPaneId)?.cwd ?? splitCwdForAnchor(anchorPaneId);
    // Host-placed when the daemon is up (survives a UI restart), else local.
    const createTerminal = resolveAuxShellPlacement?.(newId);
    registry?.ensure(newId, cwd === undefined ? undefined : { cwd }, createTerminal);
    store.actions.createPane(newId, { split: { anchorPaneId, direction } });
  }

  function runAutomation(automationId: string, anchorPaneId: PaneId): void {
    const automation = automations.find((entry) => entry.id === automationId);
    if (automation === undefined || !automation.enabled) {
      return;
    }
    // All steps open in the anchor's worktree root (immutable, deterministic),
    // falling back to the anchor's live spawn cwd.
    const cwd = splitCwdForAnchor(anchorPaneId) ?? registry?.get(anchorPaneId)?.cwd;
    let previousPaneId = anchorPaneId;
    let focusTarget: PaneId | undefined;
    for (const step of automation.steps) {
      const stepAnchor = step.anchor === "origin" ? anchorPaneId : previousPaneId;
      const newId: PaneId = `${SPLIT_PANE_ID_PREFIX}${splitSeq++}`;
      const createTerminal = resolveAuxShellPlacement?.(newId);
      registry?.ensure(newId, cwd === undefined ? undefined : { cwd }, createTerminal);
      store.actions.createPane(newId, { split: { anchorPaneId: stepAnchor, direction: step.split } });
      // Execute appends CR (the shell's line terminator) to auto-submit; write leaves the command typed.
      sendWhenReady(newId, step.run === "execute" ? `${step.command}\r` : step.command);
      previousPaneId = newId;
      if (step.focus) {
        focusTarget = newId;
      }
    }
    store.actions.focusPane(focusTarget ?? previousPaneId);
  }

  function closePane(paneId: PaneId): void {
    // Destroy the process before dropping the record. kill() closes a host-owned aux PTY on the
    // host (so a closed pane never lingers as a reattachable orphan), kills a local shell's bridge,
    // and is a no-op for an attached agent (the observer owns it — the pane then detaches on dispose).
    registry?.get(paneId)?.terminal?.kill();
    store.actions.closePane(paneId);
  }

  return {
    writeToTerminal,
    pasteToTerminal,
    scrollTerminal,
    openPane,
    splitPane,
    runAutomation,
    closePane,
  };
}
