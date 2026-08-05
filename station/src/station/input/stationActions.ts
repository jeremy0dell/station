// Execution layer for the STATION view's input. Native Station adds pane and
// control effects around shared dashboard actions without owning dashboard state
// transitions. New Session creation intercepts the resolved Create action after
// shared validation so it can launch a managed pane instead of dispatching the
// standalone observer operation.
import type { StationClientStateSource } from "@station/client";
import { worktreeHasLiveAgent, type ProviderId } from "@station/contracts";
import {
  choiceValueByKey,
  deriveTuiInputMode,
  newSessionActionForInput,
  newSessionIntentForAction,
  resolveQuickSessionIntent,
  safeErrorToToast,
  selectDashboardItems,
  selectDashboardSessionRow,
  selectDashboardViewport,
  type TuiSemanticAction,
} from "@station/dashboard-core";
import { validateForkSessionCreate, validateNewSessionCreate } from "@station/dashboard-core";
import type { TuiKey } from "@station/dashboard-core";
import type {
  DashboardActionResult,
  DashboardActions,
  DashboardStateSource,
  TuiControlIntent,
} from "@station/dashboard-core";
import {
  agentWorktreePaneId,
  projectPaneId,
  worktreePaneId,
  type PaneId,
  type PaneRole,
} from "../../state/types.js";
import { sequenceToTuiKey } from "./sequenceToTuiKey.js";

type DashboardStateInput = {
  state: DashboardStateSource;
  clientState: StationClientStateSource;
};

type DashboardTransitionInput = DashboardStateInput & {
  actions: Pick<DashboardActions, "dispatch" | "handleKey" | "pushToast">;
};

type DashboardToastDismissal = {
  actions: Pick<DashboardActions, "dismissToasts">;
};

export type StationKeyOutcome =
  /** Dispatched into the machine; the overlay stays up. */
  | { kind: "handled" }
  /** The machine reported dismiss/exit intent; the router closes STATION mode. */
  | { kind: "close-overlay" }
  /** A project-shell intent resolved to Station's native pane outcome. */
  | { kind: "open-pane"; target: OpenPaneTarget }
  /** A Quick Session intent resolved to Station's managed create outcome. */
  | { kind: "launch-new-session"; target: Extract<QuickSessionSubmitTarget, { kind: "submit" }> }
  /** No dashboard vocabulary for this sequence; swallowed, never dispatched. */
  | { kind: "unmapped" };

/**
 * The keyboard entry point the overlay keymap layer delegates to: translate
 * the normalized legacy sequence, dispatch through the machine, map the
 * transition meta to an outcome. Modal by construction — every sequence is
 * consumed whether or not it meant anything.
 */
export function handleStationSequence(
  store: DashboardTransitionInput,
  sequence: string,
): StationKeyOutcome {
  const key = sequenceToTuiKey(sequence);
  if (key === undefined) {
    return { kind: "unmapped" };
  }
  return outcomeForResult(store, store.actions.handleKey(key));
}

export function dispatchStationKey(
  store: DashboardTransitionInput,
  key: TuiKey,
): StationKeyOutcome {
  return outcomeForResult(store, store.actions.handleKey(key));
}

export function dispatchStationAction(
  store: DashboardTransitionInput,
  action: TuiSemanticAction,
): StationKeyOutcome {
  return outcomeForResult(store, store.actions.dispatch(action));
}

function outcomeForResult(
  store: DashboardTransitionInput,
  result: DashboardActionResult,
): StationKeyOutcome {
  if (result.dismissPopup || result.exitCode !== undefined) {
    return { kind: "close-overlay" };
  }
  return result.controlIntent === undefined
    ? { kind: "handled" }
    : outcomeForControlIntent(store, result.controlIntent);
}

function outcomeForControlIntent(
  store: DashboardTransitionInput,
  intent: TuiControlIntent,
): StationKeyOutcome {
  switch (intent.type) {
    case "projectShell.open": {
      const target = resolveProjectPaneTarget(store, intent.projectId);
      return target === undefined ? { kind: "handled" } : { kind: "open-pane", target };
    }
    case "quickSession.create": {
      const target = resolveQuickSessionSubmit(store, intent.projectId);
      return target.kind === "submit"
        ? { kind: "launch-new-session", target }
        : { kind: "handled" };
    }
    default:
      return assertNeverControlIntent(intent);
  }
}

function assertNeverControlIntent(intent: never): never {
  throw new Error(`Unhandled Station control intent: ${JSON.stringify(intent)}`);
}

/**
 * Dispatches a row interaction as the row's current slot key, so a click
 * means exactly what the slot accelerator means in the active mode
 * (dashboard: open session; remove/rename choose-slot: choose this row).
 * Rows without a slot (pending-operation rows) are inert.
 */
export function dispatchRowSlot(
  store: DashboardTransitionInput,
  rowId: string,
): StationKeyOutcome {
  const state = store.state.getState();
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
export function resolveRowAgentTarget(store: DashboardStateInput, rowId: string): RowAgentTarget {
  const snapshot = store.clientState.getState().snapshot;
  if (snapshot === undefined) {
    return { kind: "none" };
  }
  const sessionRow = selectDashboardSessionRow(snapshot, rowId);
  if (sessionRow === undefined || sessionRow.session.origin !== "station") {
    return { kind: "none" };
  }
  const row = sessionRow.worktree;
  if (worktreeHasLiveAgent(row) && row.agent?.sessionId !== sessionRow.session.id) {
    return { kind: "none" };
  }
  return {
    kind: "launch-managed",
    rowId: sessionRow.id,
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
  store: DashboardStateInput,
  sequence: string,
): RowAgentTarget {
  const state = store.state.getState();
  if (state.snapshot === undefined || deriveTuiInputMode(state) !== "dashboard") {
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
  store: DashboardStateInput,
  sequence: string,
): RowAgentTarget {
  if (sequenceToTuiKey(sequence)?.return !== true) {
    return { kind: "none" };
  }
  const state = store.state.getState();
  if (state.snapshot === undefined || deriveTuiInputMode(state) !== "dashboard") {
    return { kind: "none" };
  }
  const focus = state.dashboardFocus;
  if (focus?.kind !== "session") {
    return { kind: "none" };
  }
  const item = selectDashboardItems(state.snapshot, state).find(
    (candidate) => candidate.type === "session" && candidate.row.id === focus.sessionId,
  );
  if (
    item === undefined ||
    item.type !== "session" ||
    item.pendingRemove !== undefined ||
    item.pendingStart !== undefined
  ) {
    return { kind: "none" };
  }
  return resolveRowAgentTarget(store, focus.sessionId);
}

/**
 * The validated New Session create, or `none`. Unlike the shared machine — which
 * submits a tmux `session.create` — Station hosts new agents in a pane, so the
 * submit resolves to a managed launch the executor runs (create the worktree,
 * then launch it into Station like a row click).
 */
export type NewSessionSubmitTarget =
  | { kind: "submit"; projectId: string; title: string; branch: string; harness: ProviderId }
  | { kind: "none" };

/**
 * Resolve native Create only after dashboard-core has resolved the semantic action.
 * Validation stays shared; successful execution diverges here because native Station
 * creates a worktree and managed pane instead of dispatching standalone session.create.
 */
export function resolveNewSessionSubmit(
  store: DashboardStateInput,
  action: TuiSemanticAction,
): NewSessionSubmitTarget {
  const state = store.state.getState();
  if (state.screen.name !== "newSession" || action.type !== "newSession.activate") {
    return { kind: "none" };
  }
  const intent = newSessionIntentForAction(state.screen.flow, action.actionId);
  if (intent.type !== "submit") return { kind: "none" };
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
    title: validation.title,
    branch: validation.branch,
    harness: validation.harnessProvider,
  };
}

/**
 * Submit on focused Enter or direct C; field/editor keys remain the shared
 * machine's. The raw sequence keeps native managed-launch resolution aligned
 * with the overlay keyboard boundary.
 */
export function resolveKeyNewSessionSubmit(
  store: DashboardStateInput,
  sequence: string,
): NewSessionSubmitTarget {
  const key = sequenceToTuiKey(sequence);
  const state = store.state.getState();
  if (key === undefined || state.screen.name !== "newSession") return { kind: "none" };
  const actionId = newSessionActionForInput(state.screen.flow, { input: key.input, key });
  return actionId === undefined
    ? { kind: "none" }
    : resolveNewSessionSubmit(store, { type: "newSession.activate", actionId });
}

export type ForkSessionSubmitTarget =
  | {
      kind: "submit";
      projectId: string;
      sourceWorktreeId: string;
      title: string;
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
export function resolveForkSessionSubmit(store: DashboardStateInput): ForkSessionSubmitTarget {
  const state = store.state.getState();
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
    title: validation.title,
    branch: validation.branch,
    copyDirty: validation.copyDirty,
  };
}

export function resolveKeyForkSessionSubmit(
  store: DashboardStateInput,
  sequence: string,
): ForkSessionSubmitTarget {
  if (sequenceToTuiKey(sequence)?.return !== true) {
    return { kind: "none" };
  }
  const { screen } = store.state.getState();
  if (screen.name !== "fork" || screen.step !== "details" || screen.focus === "copyDirty") {
    return { kind: "none" };
  }
  return resolveForkSessionSubmit(store);
}

/**
 * Resolves native Quick Session availability to its managed create target. Uses
 * the project's default harness and a generated branch name — no wizard or
 * review screen. Blocked projects preserve their provider error and retain any
 * inline action focus; accepted targets move focus to the header Quick Session.
 */
export type QuickSessionSubmitTarget =
  | { kind: "submit"; projectId: string; title: string; branch: string; harness: ProviderId }
  | { kind: "none" };

export function resolveQuickSessionSubmit(
  store: DashboardTransitionInput,
  projectId: string,
): QuickSessionSubmitTarget {
  const intent = resolveQuickSessionIntent(store.state.getState(), projectId);
  if (intent.kind === "missing") return { kind: "none" };
  if (intent.kind === "blocked") {
    store.actions.pushToast(safeErrorToToast(intent.error));
    return { kind: "none" };
  }
  store.actions.dispatch({
    type: "dashboard.projectHeader.focus",
    projectId: intent.projectId,
    control: "quickSession",
  });
  return {
    kind: "submit",
    projectId: intent.projectId,
    title: intent.title,
    branch: intent.branch,
    harness: intent.harnessProvider,
  };
}

/**
 * Resolve `[shell]` through canonical dashboard membership while allowing a
 * pending operation to hide the row from `rowChoices`.
 */
export function resolveRowPaneTarget(
  store: DashboardStateInput,
  rowId: string,
): OpenPaneTarget | undefined {
  const snapshot = store.clientState.getState().snapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const sessionRow = selectDashboardSessionRow(snapshot, rowId);
  if (sessionRow === undefined) {
    return undefined;
  }
  const row = sessionRow.worktree;
  return { paneId: worktreePaneId(row.id), cwd: row.path, role: "shell", worktreeId: row.id };
}

/**
 * Resolve a project header to its shell pane target; cwd is the project root.
 * Projects come straight off the snapshot (headers are not row choices).
 */
export function resolveProjectPaneTarget(
  store: DashboardStateInput,
  projectId: string,
): OpenPaneTarget | undefined {
  const snapshot = store.clientState.getState().snapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return undefined;
  }
  return { paneId: projectPaneId(project.id), cwd: project.root, role: "shell" };
}

export function dismissStationToasts(store: DashboardToastDismissal): void {
  store.actions.dismissToasts();
}
