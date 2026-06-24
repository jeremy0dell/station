// The STATION view's mouse routing: one pure resolver in routeStationMouse(target,
// event, store) shape. Renderables attach stationMouseProps and never decide
// behavior; every interaction resolves here against the active mode,
// dispatching the same semantic entry points keyboard uses. Hover is
// deliberately absent: it is component-local presentation state and must
// never touch the store.
import type { StoreApi } from "zustand/vanilla";
import type { ProviderId } from "@station/contracts";
import type { TuiStore } from "@station/dashboard-core";
import type { PaneRole } from "../../state/types.js";
import type { StationMouseEvent } from "../../input/mouse.js";
import {
  dismissStationToasts,
  dispatchBindingClick,
  dispatchRowSlot,
  dispatchStationKey,
  representativeKeyForBinding,
  resolveNewSessionSubmit,
  resolveProjectPaneTarget,
  resolveRowAgentTarget,
  resolveRowPaneTarget,
  scrollStationView,
  toggleProjectCollapsed,
  type OpenPaneTarget,
  type RowAgentTarget,
  type StationKeyOutcome,
} from "./stationActions.js";
import { deriveStationMode, STATION_KEYMAP, type StationInputMode } from "./stationKeymap.js";

export type StationMouseTarget =
  | { kind: "row"; rowId: string }
  | { kind: "projectHeader"; projectId: string }
  | { kind: "link"; url: string }
  /** The `[+sh]` affordance on a worktree row: open a shell in its checkout. */
  | { kind: "openShellForRow"; rowId: string }
  /** The `[+sh]` affordance on a project header: open a shell in its root. */
  | { kind: "openShellForProject"; projectId: string }
  | { kind: "body" }
  | { kind: "scrollIndicator"; direction: "up" | "down" }
  | { kind: "footerHint"; bindingId: string }
  | { kind: "toast" }
  /** A picker line inside a sheet; the key is the line's slot accelerator. */
  | { kind: "sheetChoice"; choiceKey: string }
  /** Sheets/prompts sit above the dashboard; their backdrop absorbs input. */
  | { kind: "sheetBackdrop" };

export type StationMouseEventKind = "down" | "scroll-up" | "scroll-down";

export type StationMouseOutcome =
  /** Consumed; effect (if any) already dispatched into the view store. */
  | { kind: "handled" }
  /** Consumed; the router should close STATION mode. */
  | { kind: "close-overlay" }
  /**
   * Consumed; the router should open-or-focus a pane rooted at `cwd`. Pane
   * lifecycle is the Station coordination store's job, not the view store's,
   * so this surfaces as a router outcome the same way close-overlay does. Used
   * for the `[+sh]` shell affordances (command/args/worktreeId stay absent).
   */
  | {
      kind: "open-pane";
      paneId: string;
      cwd: string;
      role: PaneRole;
      command?: string;
      args?: readonly string[];
      worktreeId?: string;
    }
  /**
   * Consumed; the router should launch a worktree's managed primary agent. No
   * command/args: the observer resolves the harness and builds the launch plan
   * when the effect calls `prepareExternalLaunch`. Carries the worktree + pane
   * identity the effect needs to spawn and record the agent.
   */
  | {
      kind: "launch-managed";
      rowId: string;
      projectId: string;
      worktreeId: string;
      paneId: string;
      cwd: string;
    }
  /** Consumed; the router should open a URL outside Station. */
  | { kind: "open-url"; url: string }
  /**
   * Consumed; the router should create a new worktree and host its agent in a
   * Station pane. The create-hint click counterpart of the keyboard Enter on the
   * New Session review screen.
   */
  | { kind: "launch-new-session"; projectId: string; branch: string; harness: ProviderId };

const SCROLL_PAGE_ROWS = 5;

/** Modes whose tables give row slots and scrolling a meaning. */
const ROW_INTERACTIVE_MODES: ReadonlySet<StationInputMode> = new Set([
  "dashboard",
  "removeChooseSlot",
  "renameChooseSlot",
]);

export function routeStationMouse(
  target: StationMouseTarget,
  event: StationMouseEvent,
  store: StoreApi<TuiStore>,
): StationMouseOutcome {
  const eventKind = stationMouseEventKind(event);
  if (eventKind === undefined) {
    return { kind: "handled" };
  }
  const mode = deriveStationMode(store.getState());

  if (eventKind !== "down") {
    return routeStationWheel(target, eventKind, store, mode);
  }

  switch (target.kind) {
    case "row":
      if (!ROW_INTERACTIVE_MODES.has(mode)) {
        return { kind: "handled" };
      }
      // Dashboard: a row IS its session's primary agent — open-or-focus it.
      // The choose-slot modes (remove/rename) keep their slot semantics: a
      // click selects that row.
      if (mode === "dashboard") {
        return fromRowAgentTarget(resolveRowAgentTarget(store, target.rowId));
      }
      return fromKeyOutcome(dispatchRowSlot(store, target.rowId));
    case "link":
      if (mode !== "dashboard") {
        return { kind: "handled" };
      }
      return { kind: "open-url", url: target.url };
    case "projectHeader":
      if (mode !== "dashboard") {
        return { kind: "handled" };
      }
      toggleProjectCollapsed(store, target.projectId);
      return { kind: "handled" };
    case "openShellForRow":
      if (mode !== "dashboard") {
        return { kind: "handled" };
      }
      return fromPaneTarget(resolveRowPaneTarget(store, target.rowId));
    case "openShellForProject":
      if (mode !== "dashboard") {
        return { kind: "handled" };
      }
      return fromPaneTarget(resolveProjectPaneTarget(store, target.projectId));
    case "scrollIndicator":
      if (!ROW_INTERACTIVE_MODES.has(mode)) {
        return { kind: "handled" };
      }
      scrollStationView(store, target.direction === "up" ? -SCROLL_PAGE_ROWS : SCROLL_PAGE_ROWS);
      return { kind: "handled" };
    case "footerHint": {
      const binding = bindingById(mode, target.bindingId);
      if (binding === undefined) {
        return { kind: "handled" };
      }
      // A click on the New Session review screen's create hint hosts the agent in
      // Station, matching the keyboard Enter path (resolveKeyNewSessionSubmit).
      if (representativeKeyForBinding(binding)?.return === true) {
        const submit = resolveNewSessionSubmit(store);
        if (submit.kind === "submit") {
          return {
            kind: "launch-new-session",
            projectId: submit.projectId,
            branch: submit.branch,
            harness: submit.harness,
          };
        }
      }
      return fromKeyOutcome(dispatchBindingClick(store, binding));
    }
    case "toast":
      dismissStationToasts(store);
      return { kind: "handled" };
    case "sheetChoice":
      if (!SHEET_CHOICE_MODES.has(mode)) {
        return { kind: "handled" };
      }
      return fromKeyOutcome(dispatchStationKey(store, { input: target.choiceKey }));
    case "body":
    case "sheetBackdrop":
      return { kind: "handled" };
  }
}

export function stationMouseEventKind(event: StationMouseEvent): StationMouseEventKind | undefined {
  if (event.type === "scroll") {
    if (event.scrollDirection === "up") {
      return "scroll-up";
    }
    if (event.scrollDirection === "down") {
      return "scroll-down";
    }
    return undefined;
  }
  if (event.type === "down" && event.button === "left") {
    return "down";
  }
  return undefined;
}

/** Modes whose sheets list slot-keyed choices a click can select. */
const SHEET_CHOICE_MODES: ReadonlySet<StationInputMode> = new Set([
  "newSessionPickProject",
  "newSessionPickAgent",
]);

function routeStationWheel(
  target: StationMouseTarget,
  eventKind: "scroll-up" | "scroll-down",
  store: StoreApi<TuiStore>,
  mode: StationInputMode,
): StationMouseOutcome {
  // Sheets and prompts must not scroll the dashboard beneath them.
  if (target.kind === "sheetBackdrop" || !ROW_INTERACTIVE_MODES.has(mode)) {
    return { kind: "handled" };
  }
  scrollStationView(store, eventKind === "scroll-up" ? -1 : 1);
  return { kind: "handled" };
}

function bindingById(mode: StationInputMode, bindingId: string) {
  return STATION_KEYMAP[mode].find((binding) => binding.id === bindingId);
}

function fromKeyOutcome(outcome: StationKeyOutcome): StationMouseOutcome {
  return outcome.kind === "close-overlay" ? { kind: "close-overlay" } : { kind: "handled" };
}

/** An unresolvable target (stale row, missing project) is an inert click. */
function fromPaneTarget(target: OpenPaneTarget | undefined): StationMouseOutcome {
  if (target === undefined) {
    return { kind: "handled" };
  }
  // Build the optional fields with explicit assignments (exactOptionalPropertyTypes):
  // the shell path leaves command/args/worktreeId absent rather than set to undefined.
  const outcome: Extract<StationMouseOutcome, { kind: "open-pane" }> = {
    kind: "open-pane",
    paneId: target.paneId,
    cwd: target.cwd,
    role: target.role,
  };
  if (target.command !== undefined) {
    outcome.command = target.command;
  }
  if (target.args !== undefined) {
    outcome.args = target.args;
  }
  if (target.worktreeId !== undefined) {
    outcome.worktreeId = target.worktreeId;
  }
  return outcome;
}

/**
 * Map a resolved row-agent target to an outcome: `launch-managed` surfaces a
 * managed-launch router outcome (the effect then asks the observer to prepare
 * the launch), `none` (stale row / no snapshot) is an inert click.
 */
function fromRowAgentTarget(result: RowAgentTarget): StationMouseOutcome {
  switch (result.kind) {
    case "launch-managed":
      return {
        kind: "launch-managed",
        rowId: result.rowId,
        projectId: result.projectId,
        worktreeId: result.worktreeId,
        paneId: result.paneId,
        cwd: result.cwd,
      };
    case "none":
      return { kind: "handled" };
  }
}
