// The STATION view's mouse routing: one pure resolver in routeStationMouse(target,
// event, store) shape. Renderables attach stationMouseProps and never decide
// behavior; every interaction resolves here against the active mode,
// dispatching the same semantic entry points keyboard uses. Hover is
// deliberately absent: it is component-local presentation state and must
// never touch the store.
import type { StoreApi } from "zustand/vanilla";
import type { ProviderId } from "@station/contracts";
import {
  deriveTuiInputMode,
  isRemoveProjectArmed,
  LIST_REGISTRY,
  type ProjectSettingsItemId,
  type TuiInputMode,
  type TuiStore,
} from "@station/dashboard-core";
import type { PaneRole } from "../../state/types.js";
import type { StationMouseEvent } from "../../input/mouse.js";
import {
  addWidgetSettingsPickerChoice,
  dismissStationToasts,
  dispatchRowSlot,
  dispatchStationKey,
  focusProjectSettingsItem,
  openDefaultAgentPickerForProject,
  openWidgetSettingsPanel,
  openWidgetSettingsPicker,
  removeWidgetSettingsRow,
  toggleWidgetSettingsRow,
  resolveForkSessionSubmit,
  resolveProjectPaneTarget,
  resolveQuickSessionSubmit,
  resolveRowAgentTarget,
  resolveRowPaneTarget,
  scrollStationView,
  selectAddProjectRow,
  toggleProjectCollapsed,
  type OpenPaneTarget,
  type RowAgentTarget,
  type StationKeyOutcome,
} from "./stationActions.js";

export type StationMouseTarget =
  | { kind: "row"; rowId: string }
  | { kind: "projectHeader"; projectId: string }
  | { kind: "link"; url: string }
  /** The `[+sh]` affordance on a session row: open a shell in its checkout. */
  | { kind: "openShellForRow"; rowId: string }
  /** The `[+sh]` affordance on a project header: open a shell in its root. */
  | { kind: "openShellForProject"; projectId: string }
  /** The `[+]` quick-session affordance on a project header. */
  | { kind: "quickSessionForProject"; projectId: string }
  /** The `[▾]` default-agent affordance on a project header. */
  | { kind: "showDefaultAgentPickerForProject"; projectId: string }
  | { kind: "body" }
  | { kind: "scrollIndicator"; direction: "up" | "down" }
  | { kind: "toast" }
  /** A picker line inside a sheet; the key is the line's slot accelerator. */
  | { kind: "sheetChoice"; choiceKey: string }
  /** A compact sheet button that dispatches its visible shortcut key. */
  | { kind: "sheetButton"; key: "y" | "n" }
  /** A left-list row in the Project Settings panel; selecting opens its detail. */
  | { kind: "projectSettingsItem"; itemId: ProjectSettingsItemId }
  /** The armed "Remove project (R)" action in the panel's detail pane. */
  | { kind: "projectSettingsConfirmRemove" }
  /** The header `[+]` affordance: opens the widget-settings panel. */
  | { kind: "widgetSettingsOpen" }
  /** A widget row in the settings panel; clicking toggles it on/off. */
  | { kind: "widgetSettingsRow"; index: number }
  /** The per-row `×` in the settings panel. */
  | { kind: "widgetSettingsRemove"; index: number }
  /** The panel's trailing "[ + add widget ]" line. */
  | { kind: "widgetSettingsAdd" }
  /** A choice row in the add-widget picker. */
  | { kind: "widgetSettingsPickerChoice"; index: number }
  /** A folder/start row in the add-project browser; clicking moves the cursor there. */
  | { kind: "addProjectRow"; index: number }
  /** A sheet's primary submit button (the fork details "Fork" action). */
  | { kind: "sheetSubmit" }
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
  | { kind: "launch-new-session"; projectId: string; branch: string; harness: ProviderId }
  /**
   * Consumed; the router should seed a worktree off a source and host its agent
   * in a Station pane. The fork-button click counterpart of the keyboard Enter on
   * the Fork details screen.
   */
  | {
      kind: "launch-fork";
      projectId: string;
      sourceWorktreeId: string;
      branch: string;
      copyDirty: boolean;
    };

const SCROLL_PAGE_ROWS = 5;

/** Modes whose tables give row slots and scrolling a meaning. */
const ROW_INTERACTIVE_MODES: ReadonlySet<TuiInputMode> = new Set([
  "dashboard",
  "removeChooseSlot",
  "renameChooseSlot",
  "forkChooseSlot",
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
  const mode = deriveTuiInputMode(store.getState());

  if (eventKind !== "down") {
    return routeStationWheel(target, eventKind, store, mode);
  }

  switch (target.kind) {
    case "row": {
      if (!ROW_INTERACTIVE_MODES.has(mode)) {
        return { kind: "handled" };
      }
      // Dashboard: a row IS its session's primary agent — open-or-focus it.
      // The choose-slot modes (remove/rename) keep their slot semantics: a
      // click selects that row.
      if (mode === "dashboard") {
        return routeDashboardRow(store, target.rowId);
      }
      return fromKeyOutcome(dispatchRowSlot(store, target.rowId));
    }
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
    case "quickSessionForProject":
      if (mode !== "dashboard") {
        return { kind: "handled" };
      }
      return fromQuickSessionSubmit(resolveQuickSessionSubmit(store, target.projectId));
    case "showDefaultAgentPickerForProject":
      if (mode !== "dashboard") {
        return { kind: "handled" };
      }
      openDefaultAgentPickerForProject(store, target.projectId);
      return { kind: "handled" };
    case "scrollIndicator":
      if (!ROW_INTERACTIVE_MODES.has(mode)) {
        return { kind: "handled" };
      }
      scrollStationView(store, target.direction === "up" ? -SCROLL_PAGE_ROWS : SCROLL_PAGE_ROWS);
      return { kind: "handled" };
    case "toast":
      dismissStationToasts(store);
      return { kind: "handled" };
    case "sheetChoice":
      if (!SHEET_CHOICE_MODES.has(mode)) {
        return { kind: "handled" };
      }
      return fromKeyOutcome(dispatchStationKey(store, { input: target.choiceKey }));
    case "sheetButton":
      if (mode !== "removeConfirm") {
        return { kind: "handled" };
      }
      return fromKeyOutcome(dispatchStationKey(store, { input: target.key }));
    case "projectSettingsItem":
      if (mode !== "projectSettings") {
        return { kind: "handled" };
      }
      focusProjectSettingsItem(store, target.itemId);
      return { kind: "handled" };
    case "widgetSettingsOpen":
      if (mode !== "dashboard") {
        return { kind: "handled" };
      }
      openWidgetSettingsPanel(store);
      return { kind: "handled" };
    case "widgetSettingsRow":
      if (mode !== "widgetSettings") {
        return { kind: "handled" };
      }
      toggleWidgetSettingsRow(store, target.index);
      return { kind: "handled" };
    case "widgetSettingsRemove":
      if (mode !== "widgetSettings") {
        return { kind: "handled" };
      }
      removeWidgetSettingsRow(store, target.index);
      return { kind: "handled" };
    case "widgetSettingsAdd":
      if (mode !== "widgetSettings") {
        return { kind: "handled" };
      }
      openWidgetSettingsPicker(store);
      return { kind: "handled" };
    case "widgetSettingsPickerChoice":
      if (mode !== "widgetSettings") {
        return { kind: "handled" };
      }
      addWidgetSettingsPickerChoice(store, target.index);
      return { kind: "handled" };
    case "addProjectRow":
      if (mode !== "addProject") {
        return { kind: "handled" };
      }
      selectAddProjectRow(store, target.index);
      return { kind: "handled" };
    case "projectSettingsConfirmRemove": {
      if (mode !== "projectSettings") {
        return { kind: "handled" };
      }
      // Only an armed button fires. Dispatching "r" while unarmed would be typed
      // into the confirm field (the machine treats "r" as editable text until the
      // phrase matches), so guard the click here rather than emit a stray key.
      const { screen } = store.getState();
      if (screen.name === "projectSettings" && isRemoveProjectArmed(screen)) {
        return fromKeyOutcome(dispatchStationKey(store, { input: "r" }));
      }
      return { kind: "handled" };
    }
    case "sheetSubmit": {
      // A click on the Fork details "Fork" button hosts the agent in Station,
      // matching the keyboard Enter path (resolveKeyForkSessionSubmit) rather than
      // dispatching the machine's tmux-bound session.fork.
      if (mode !== "forkDetails") {
        return { kind: "handled" };
      }
      const submit = resolveForkSessionSubmit(store);
      if (submit.kind === "none") {
        return { kind: "handled" };
      }
      return {
        kind: "launch-fork",
        projectId: submit.projectId,
        sourceWorktreeId: submit.sourceWorktreeId,
        branch: submit.branch,
        copyDirty: submit.copyDirty,
      };
    }
    case "body":
    case "sheetBackdrop":
      return { kind: "handled" };
  }
}

function routeDashboardRow(
  store: StoreApi<TuiStore>,
  rowId: string,
): StationMouseOutcome {
  const target = resolveRowAgentTarget(store, rowId);
  return target.kind === "launch-managed"
    ? fromRowAgentTarget(target)
    : fromKeyOutcome(dispatchRowSlot(store, rowId));
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

// Modes whose sheets list slot-keyed choices a click can select — exactly the
// registered selection lists, derived so this set cannot drift from the engine.
const SHEET_CHOICE_MODES: ReadonlySet<TuiInputMode> = new Set(
  Object.keys(LIST_REGISTRY) as TuiInputMode[],
);

function routeStationWheel(
  target: StationMouseTarget,
  eventKind: "scroll-up" | "scroll-down",
  store: StoreApi<TuiStore>,
  mode: TuiInputMode,
): StationMouseOutcome {
  // Sheets and prompts must not scroll the dashboard beneath them.
  if (target.kind === "sheetBackdrop" || !ROW_INTERACTIVE_MODES.has(mode)) {
    return { kind: "handled" };
  }
  scrollStationView(store, eventKind === "scroll-up" ? -1 : 1);
  return { kind: "handled" };
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
 * Map a quick-session submit to an outcome: `submit` surfaces a
 * `launch-new-session` router outcome (the executor creates the worktree and
 * hosts the agent). Blocked projects have already emitted an error toast;
 * `none` means only a stale or missing target and remains inert.
 */
function fromQuickSessionSubmit(
  result: ReturnType<typeof resolveQuickSessionSubmit>,
): StationMouseOutcome {
  if (result.kind === "submit") {
    return {
      kind: "launch-new-session",
      projectId: result.projectId,
      branch: result.branch,
      harness: result.harness,
    };
  }
  return { kind: "handled" };
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
