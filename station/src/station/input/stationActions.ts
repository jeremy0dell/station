// Execution layer for the STATION view's input. Most keyboard input flows through
// the shared transition machine (single behavioral source); this module is the
// semantic entry point mouse targets and chrome (footer hints) use to reach the
// same machine, plus the few Station mouse extensions that have no keyboard
// path in apps/tui (direct project-header collapse, wheel paging). Every
// mutation here lands via store.handleKey or a shared pure state function — no
// bespoke screen logic, except where a Station-only action diverges from the
// shared machine: a worktree-row slot key (resolveKeyRowAgentTarget) and the New
// Session submit (resolveKeyNewSessionSubmit) are resolved here so keyboard and
// mouse reach the same Station managed-launch path.
import type { StoreApi } from "zustand/vanilla";
import type { ProviderId } from "@station/contracts";
import {
  choiceValueByKey,
  createNewSessionNameToken,
  newSessionIntentForInput,
  focusProjectSettingsItem as focusProjectSettingsItemState,
  generatedSessionBranch,
  openProjectDefaultAgentPicker,
  openWidgetSettings as openWidgetSettingsState,
  selectAddProjectRow as selectAddProjectRowState,
  selectDashboardItems,
  selectDashboardViewport,
  widgetSettingsAddFromPicker,
  widgetSettingsOpenPicker,
  widgetSettingsRemoveAt,
  widgetSettingsToggleAt,
  type ProjectSettingsItemId,
} from "@station/dashboard-core";
import { clampDashboardStateScroll, scrollDashboard } from "@station/dashboard-core";
import { validateForkSessionCreate, validateNewSessionCreate } from "@station/dashboard-core";
import type { TuiKey } from "@station/dashboard-core";
import type { TuiHandleKeyResult, TuiStore } from "@station/dashboard-core";
import {
  agentWorktreePaneId,
  projectPaneId,
  worktreePaneId,
  type PaneId,
  type PaneRole,
} from "../../state/types.js";
import { sequenceToTuiKey } from "./sequenceToTuiKey.js";
import { matchStationBinding, deriveStationMode, type StationBinding } from "./stationKeymap.js";

export type StationKeyOutcome =
  /** Dispatched into the machine; the overlay stays up. */
  | { kind: "handled" }
  /** The machine reported dismiss/exit intent; the router closes STATION mode. */
  | { kind: "close-overlay" }
  /** No dashboard vocabulary for this sequence; swallowed, never dispatched. */
  | { kind: "unmapped" };

/**
 * The keyboard entry point the overlay keymap layer delegates to: translate
 * the normalized legacy sequence, dispatch through the machine, map the
 * transition meta to an outcome. Modal by construction — every sequence is
 * consumed whether or not it meant anything.
 */
export function handleStationSequence(store: StoreApi<TuiStore>, sequence: string): StationKeyOutcome {
  const key = sequenceToTuiKey(sequence);
  if (key === undefined) {
    return { kind: "unmapped" };
  }
  return outcomeForResult(store.getState().handleKey(key));
}

export function dispatchStationKey(store: StoreApi<TuiStore>, key: TuiKey): StationKeyOutcome {
  return outcomeForResult(store.getState().handleKey(key));
}

function outcomeForResult(result: TuiHandleKeyResult): StationKeyOutcome {
  if (result.dismissPopup || result.exitCode !== undefined) {
    return { kind: "close-overlay" };
  }
  return { kind: "handled" };
}

/**
 * Synthesizes the representative key for a binding so clickable chrome
 * (footer hints, help rows) can dispatch exactly what pressing the key
 * would. Slot and text patterns have no single representative key.
 */
export function representativeKeyForBinding(binding: StationBinding): TuiKey | undefined {
  const pattern = binding.pattern;
  switch (pattern.kind) {
    case "char":
      return pattern.ctrl === true ? { input: pattern.char, ctrl: true } : { input: pattern.char };
    case "named":
      switch (pattern.named) {
        case "return":
          return { input: "\r", return: true };
        case "escape":
          return { input: "", escape: true };
        case "backspace":
          return { input: "", backspace: true };
        case "delete":
          return { input: "", delete: true };
        case "up":
          return { input: "", upArrow: true };
        case "down":
          return { input: "", downArrow: true };
        case "left":
          return { input: "", leftArrow: true };
        case "right":
          return { input: "", rightArrow: true };
      }
      return undefined;
    case "slot":
    case "text":
      return undefined;
  }
}

/**
 * Dispatches a row interaction as the row's current slot key, so a click
 * means exactly what the slot accelerator means in the active mode
 * (dashboard: start-or-focus; remove/rename choose-slot: choose this row).
 * Rows without a slot (pending-operation rows) are inert.
 */
export function dispatchRowSlot(store: StoreApi<TuiStore>, rowId: string): StationKeyOutcome {
  const state = store.getState();
  if (state.snapshot === undefined) {
    return { kind: "handled" };
  }
  const choice = selectDashboardViewport(state.snapshot, state).rowChoices.find(
    (candidate) => candidate.value.id === rowId,
  );
  if (choice === undefined) {
    return { kind: "handled" };
  }
  return dispatchStationKey(store, { input: choice.key });
}

/**
 * Resolved pane spawn target. Shells carry cwd only; primary-agent targets add
 * command metadata. `worktreeId` lets worktree shells attach to an existing
 * primary-agent pane.
 */
export type OpenPaneTarget = {
  paneId: PaneId;
  cwd: string;
  role: PaneRole;
  command?: string;
  args?: readonly string[];
  worktreeId?: string;
};

/**
 * Managed launch target carries identity only; the observer resolves the harness
 * command later in `prepareExternalLaunch`.
 */
export type RowAgentTarget =
  | {
      kind: "launch-managed";
      rowId: string;
      projectId: string;
      worktreeId: string;
      paneId: PaneId;
      cwd: string;
    }
  | { kind: "none" };

/**
 * Resolve a row to observer-prepared managed launch identity; absent/stale rows
 * produce an inert `none`.
 */
export function resolveRowAgentTarget(store: StoreApi<TuiStore>, rowId: string): RowAgentTarget {
  const snapshot = store.getState().snapshot;
  if (snapshot === undefined) {
    return { kind: "none" };
  }
  const row = snapshot.rows.find((candidate) => candidate.id === rowId);
  if (row === undefined) {
    return { kind: "none" };
  }
  return {
    kind: "launch-managed",
    rowId: row.id,
    projectId: row.projectId,
    worktreeId: row.id,
    paneId: agentWorktreePaneId(row.id),
    cwd: row.path,
  };
}

/**
 * In dashboard mode, slot keys reuse the row-click launch path. Other modes or
 * non-slot keys fall back to the shared machine.
 */
export function resolveKeyRowAgentTarget(
  store: StoreApi<TuiStore>,
  sequence: string,
): RowAgentTarget {
  const state = store.getState();
  if (state.snapshot === undefined || deriveStationMode(state) !== "dashboard") {
    return { kind: "none" };
  }
  const row = choiceValueByKey(selectDashboardViewport(state.snapshot, state).rowChoices, sequence);
  return row === undefined ? { kind: "none" } : resolveRowAgentTarget(store, row.id);
}

/**
 * Enter opens the focused row exactly as its slot key / click does: same
 * RowAgentTarget, same managed-launch path. The shared machine's ↵ activation
 * dispatches terminal.focus, which Station-hosted panes can't honor, so the
 * overlay intercepts here. `none` when nothing is focused, the row left the
 * snapshot, or an operation is already pending on it.
 */
export function resolveKeyFocusedRowAgentTarget(
  store: StoreApi<TuiStore>,
  sequence: string,
): RowAgentTarget {
  if (sequenceToTuiKey(sequence)?.return !== true) {
    return { kind: "none" };
  }
  const state = store.getState();
  if (state.snapshot === undefined || deriveStationMode(state) !== "dashboard") {
    return { kind: "none" };
  }
  const focusedRowId = state.focusedRowId;
  if (focusedRowId === undefined) {
    return { kind: "none" };
  }
  const item = selectDashboardItems(state.snapshot, state).find(
    (candidate) => candidate.type === "worktree" && candidate.row.id === focusedRowId,
  );
  if (
    item === undefined ||
    item.type !== "worktree" ||
    item.pendingRemove !== undefined ||
    item.pendingStart !== undefined
  ) {
    return { kind: "none" };
  }
  return resolveRowAgentTarget(store, focusedRowId);
}

/**
 * The validated New Session create, or `none`. Unlike the shared machine — which
 * submits a tmux `session.create` — Station hosts new agents in a pane, so the
 * submit resolves to a managed launch the executor runs (create the worktree,
 * then launch it into Station like a row click).
 */
export type NewSessionSubmitTarget =
  | { kind: "submit"; projectId: string; branch: string; harness: ProviderId }
  | { kind: "none" };

/**
 * Resolve the New Session review screen to its create. `none` off the review
 * step or when validation fails — both fall through to the shared machine
 * (navigation keys act normally; an invalid create surfaces its error toast).
 */
export function resolveNewSessionSubmit(store: StoreApi<TuiStore>): NewSessionSubmitTarget {
  const state = store.getState();
  if (state.screen.name !== "newSession") {
    return { kind: "none" };
  }
  // The machine owns what ↵ means (reviewFocusIntents): submit only when it
  // would submit, so a focused field's ↵ reaches the machine and opens its step.
  const intent = newSessionIntentForInput(state.screen.flow, {
    input: "\r",
    key: { return: true },
    token: "",
  });
  if (intent.type !== "submit") {
    return { kind: "none" };
  }
  if (state.snapshot === undefined) {
    return { kind: "none" };
  }
  const validation = validateNewSessionCreate(state.snapshot, state.screen.flow);
  if (!validation.ok) {
    return { kind: "none" };
  }
  return {
    kind: "submit",
    projectId: validation.project.id,
    branch: validation.branch.trim(),
    harness: validation.harnessProvider,
  };
}

/**
 * Submit only on Enter; every other key (wizard navigation, name editing) is the
 * shared machine's. Takes the raw sequence like resolveKeyRowAgentTarget (the
 * overlay catchAll hands strings, not TuiKeys) so the keyboard submit and a
 * create-hint click reach the same managed launch.
 */
export function resolveKeyNewSessionSubmit(
  store: StoreApi<TuiStore>,
  sequence: string,
): NewSessionSubmitTarget {
  if (sequenceToTuiKey(sequence)?.return !== true) {
    return { kind: "none" };
  }
  return resolveNewSessionSubmit(store);
}

export type ForkSessionSubmitTarget =
  | {
      kind: "submit";
      projectId: string;
      sourceWorktreeId: string;
      branch: string;
      copyDirty: boolean;
    }
  | { kind: "none" };

/**
 * Resolve the Fork details screen to its launch. `none` off the details step or
 * when validation fails — both fall through to the shared machine, where
 * submitFork re-validates and surfaces the inline error. The happy path is
 * intercepted here so the launch hosts the agent in Station rather than running
 * the machine's tmux-bound session.fork.
 */
export function resolveForkSessionSubmit(store: StoreApi<TuiStore>): ForkSessionSubmitTarget {
  const state = store.getState();
  if (state.screen.name !== "fork" || state.screen.step !== "details") {
    return { kind: "none" };
  }
  if (state.snapshot === undefined) {
    return { kind: "none" };
  }
  const validation = validateForkSessionCreate(state.snapshot, state.screen);
  if (!validation.ok) {
    return { kind: "none" };
  }
  return {
    kind: "submit",
    projectId: validation.project.id,
    sourceWorktreeId: validation.sourceWorktreeId,
    branch: validation.branch,
    copyDirty: validation.copyDirty,
  };
}

export function resolveKeyForkSessionSubmit(
  store: StoreApi<TuiStore>,
  sequence: string,
): ForkSessionSubmitTarget {
  if (sequenceToTuiKey(sequence)?.return !== true) {
    return { kind: "none" };
  }
  return resolveForkSessionSubmit(store);
}

/**
 * Resolve a project header's quick-session click to its create target. Uses
 * the project's default harness and a generated branch name — no wizard, no
 * review screen. Returns `none` if the project is unavailable or missing, so
 * the click is an inert miss.
 */
export type QuickSessionSubmitTarget =
  | { kind: "submit"; projectId: string; branch: string; harness: ProviderId }
  | { kind: "none" };

export function resolveQuickSessionSubmit(
  store: StoreApi<TuiStore>,
  projectId: string,
): QuickSessionSubmitTarget {
  const snapshot = store.getState().snapshot;
  if (snapshot === undefined) {
    return { kind: "none" };
  }
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined || project.health.status === "unavailable") {
    return { kind: "none" };
  }
  const branch = generatedSessionBranch(project.id, createNewSessionNameToken());
  return {
    kind: "submit",
    projectId: project.id,
    branch,
    harness: project.defaults.harness,
  };
}

/**
 * Open the project default-agent picker. Pure store mutation — no router
 * outcome. Absent or unavailable projects are silently ignored.
 */
export function openDefaultAgentPickerForProject(
  store: StoreApi<TuiStore>,
  projectId: string,
): void {
  store.setState(openProjectDefaultAgentPicker(store.getState(), projectId));
}

/**
 * Station mouse extension: clicking a left-list item selects it and drops into
 * its detail pane. No single keyboard key maps to this (the keyboard path is
 * arrow-move then enter), so it lives here like the header-collapse toggle.
 */
export function focusProjectSettingsItem(
  store: StoreApi<TuiStore>,
  itemId: ProjectSettingsItemId,
): void {
  store.setState(focusProjectSettingsItemState(store.getState(), itemId));
}

/** Header `[+]` affordance: open the widget-settings panel from the dashboard. */
export function openWidgetSettingsPanel(store: StoreApi<TuiStore>): void {
  store.setState(openWidgetSettingsState(store.getState()));
}

export function toggleWidgetSettingsRow(store: StoreApi<TuiStore>, index: number): void {
  store.setState(widgetSettingsToggleAt(store.getState(), index));
}

export function selectAddProjectRow(store: StoreApi<TuiStore>, index: number): void {
  store.setState(selectAddProjectRowState(store.getState(), index));
}

export function removeWidgetSettingsRow(store: StoreApi<TuiStore>, index: number): void {
  store.setState(widgetSettingsRemoveAt(store.getState(), index));
}

export function openWidgetSettingsPicker(store: StoreApi<TuiStore>): void {
  store.setState(widgetSettingsOpenPicker(store.getState()));
}

export function addWidgetSettingsPickerChoice(store: StoreApi<TuiStore>, index: number): void {
  store.setState(widgetSettingsAddFromPicker(store.getState(), index));
}

/**
 * Resolve `[+sh]` from snapshot rows, not dashboard choices: pending-start/remove
 * rows still represent real worktrees even when `rowChoices` filters them out.
 */
export function resolveRowPaneTarget(
  store: StoreApi<TuiStore>,
  rowId: string,
): OpenPaneTarget | undefined {
  const snapshot = store.getState().snapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const row = snapshot.rows.find((candidate) => candidate.id === rowId);
  if (row === undefined) {
    return undefined;
  }
  return { paneId: worktreePaneId(row.id), cwd: row.path, role: "shell", worktreeId: row.id };
}

/**
 * Resolve a project header to its shell pane target; cwd is the project root.
 * Projects come straight off the snapshot (headers are not row choices).
 */
export function resolveProjectPaneTarget(
  store: StoreApi<TuiStore>,
  projectId: string,
): OpenPaneTarget | undefined {
  const snapshot = store.getState().snapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return undefined;
  }
  return { paneId: projectPaneId(project.id), cwd: project.root, role: "shell" };
}

/**
 * Station mouse extension: direct project collapse toggle (apps/tui's
 * keyboard path goes through the C prompt; the visual notes specify
 * header-click toggle). Same state mutation the collapse screen performs.
 */
export function toggleProjectCollapsed(store: StoreApi<TuiStore>, projectId: string): void {
  const state = store.getState();
  const collapsedProjectIds = new Set(state.collapsedProjectIds);
  if (collapsedProjectIds.has(projectId)) {
    collapsedProjectIds.delete(projectId);
  } else {
    collapsedProjectIds.add(projectId);
  }
  store.setState(clampDashboardStateScroll({ ...state, collapsedProjectIds }));
}

/** Wheel/indicator scrolling via the shared scroll math. */
export function scrollStationView(store: StoreApi<TuiStore>, delta: number): void {
  store.setState(scrollDashboard(store.getState(), delta));
}

export function dismissStationToasts(store: StoreApi<TuiStore>): void {
  store.getState().dismissToasts();
}

/**
 * Dispatches a footer/help hint click as its binding's representative key,
 * but only when the binding belongs to the active mode (a stale hint from a
 * just-closed mode must not fire).
 */
export function dispatchBindingClick(
  store: StoreApi<TuiStore>,
  binding: StationBinding,
): StationKeyOutcome {
  const mode = deriveStationMode(store.getState());
  const key = representativeKeyForBinding(binding);
  if (key === undefined) {
    return { kind: "handled" };
  }
  const active = matchStationBinding(mode, key);
  if (active?.id !== binding.id) {
    return { kind: "handled" };
  }
  return dispatchStationKey(store, key);
}
