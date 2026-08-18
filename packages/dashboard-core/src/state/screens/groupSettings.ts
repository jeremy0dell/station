import type { SessionGroupId, SessionId, StationSnapshot } from "@station/contracts";
import {
  createEditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import {
  buildDeleteSessionGroupCommand,
  buildRenameSessionGroupCommand,
  buildUpdateSessionGroupMembershipDeltaCommand,
} from "../commandBuilders.js";
import { focusDashboardGroup } from "../dashboardFocus.js";
import { isReturnKey, type TuiKey } from "../keys.js";
import {
  resolveSettingsPanelListIntent,
  type SettingsPanelNavigationItem,
} from "../settingsPanelNavigation.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState, GroupSettingsDetailFocus, GroupSettingsSection } from "../types.js";

type GroupSettingsScreen = Extract<DashboardState["screen"], { name: "groupSettings" }>;

export type GroupSettingsItem = SettingsPanelNavigationItem<GroupSettingsSection> & {
  label: string;
  shortcut: "G" | "S" | "R";
};

export const GROUP_SETTINGS_ITEMS: readonly GroupSettingsItem[] = [
  { id: "general", label: "General", shortcut: "G" },
  { id: "sessions", label: "Sessions", shortcut: "S" },
  { id: "remove", label: "Remove Group", shortcut: "R" },
];

export const groupSettingsScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: cancelGroupSettings,
};

/** The exact typed-name phrase required before Group deletion is enabled. */
export function removeSessionGroupConfirmPhrase(groupName: string): string {
  return `delete ${groupName}`;
}

export function isRemoveSessionGroupArmed(screen: GroupSettingsScreen): boolean {
  return screen.removeDraft.value.trim() === removeSessionGroupConfirmPhrase(screen.baselineName);
}

/** Opens one stable Group destination and anchors cancellation to its menu cell. */
export function openGroupSettings(
  state: DashboardState,
  groupId: SessionGroupId,
  section: GroupSettingsSection = "general",
): DashboardState {
  const snapshot = state.snapshot;
  const group = snapshot?.sessionGroups.find((candidate) => candidate.id === groupId);
  if (
    snapshot === undefined ||
    group === undefined ||
    !snapshot.projects.some((project) => project.id === group.projectId)
  ) {
    return state;
  }
  const seeded = seedGroupSettingsScreen(snapshot, groupId, section, "list");
  if (seeded === undefined) return state;
  const anchored = focusDashboardGroup(state, groupId, "menu");
  return {
    ...anchored,
    screen: seeded,
  };
}

/** Selects and freshly seeds a section; abandoned section edits are discarded. */
export function selectGroupSettingsSection(
  state: DashboardState,
  section: GroupSettingsSection,
  focus: "list" | "detail" = "detail",
): DashboardState {
  if (state.screen.name !== "groupSettings" || state.screen.pending !== undefined) return state;
  const snapshot = state.snapshot;
  if (snapshot === undefined) return state;
  const screen = seedGroupSettingsScreen(snapshot, state.screen.groupId, section, focus);
  return screen === undefined ? state : { ...state, screen };
}

/** Focuses one rendered detail control without synthesizing keyboard input. */
export function focusGroupSettingsControl(
  state: DashboardState,
  detailFocus: GroupSettingsDetailFocus,
): DashboardState {
  if (
    state.screen.name !== "groupSettings" ||
    state.screen.pending !== undefined ||
    !controlBelongsToSection(detailFocus, state.screen.section)
  ) {
    return state;
  }
  return { ...state, screen: { ...state.screen, focus: "detail", detailFocus } };
}

/** Stages one desired membership selection and keeps the stable session cursor on it. */
export function toggleGroupSettingsSession(
  state: DashboardState,
  sessionId: SessionId,
): DashboardState {
  if (
    state.screen.name !== "groupSettings" ||
    state.screen.section !== "sessions" ||
    state.screen.pending !== undefined ||
    !state.screen.baselineAssignments.has(sessionId)
  ) {
    return state;
  }
  const desiredSessionIds = new Set(state.screen.desiredSessionIds);
  if (desiredSessionIds.has(sessionId)) desiredSessionIds.delete(sessionId);
  else desiredSessionIds.add(sessionId);
  return {
    ...state,
    screen: {
      ...state.screen,
      focus: "detail",
      detailFocus: "sessionList",
      sessionCursor: sessionId,
      desiredSessionIds,
    },
  };
}

/** Submits the active section's single recorded mutation, when its draft has a delta. */
export function submitGroupSettings(state: DashboardState): TuiTransition {
  if (
    state.screen.name !== "groupSettings" ||
    state.screen.pending !== undefined ||
    state.snapshot === undefined
  ) {
    return { state };
  }
  const screen = state.screen;
  if (screen.section === "general") {
    const name = screen.nameDraft.value.trim();
    if (name.length === 0 || name === screen.baselineName) return { state };
    return {
      state: {
        ...state,
        screen: { ...screen, detailFocus: "generalSave", pending: "rename" },
      },
      operations: [
        {
          type: "renameSessionGroup",
          projectId: screen.projectId,
          groupId: screen.groupId,
          command: buildRenameSessionGroupCommand({
            projectId: screen.projectId,
            groupId: screen.groupId,
            expectedVersion: screen.expectedVersion,
            name,
          }),
        },
      ],
    };
  }
  if (screen.section === "sessions") {
    const command = membershipCommand(screen);
    if (command === undefined) return { state };
    return {
      state: {
        ...state,
        screen: { ...screen, detailFocus: "membershipSave", pending: "membership" },
      },
      operations: [
        {
          type: "updateSessionGroupMembership",
          projectId: screen.projectId,
          groupId: screen.groupId,
          command,
        },
      ],
    };
  }
  if (!isRemoveSessionGroupArmed(screen)) return { state };
  return {
    state: {
      ...state,
      screen: { ...screen, detailFocus: "removeSubmit", pending: "delete" },
    },
    operations: [
      {
        type: "deleteSessionGroup",
        projectId: screen.projectId,
        groupId: screen.groupId,
        command: buildDeleteSessionGroupCommand({
          projectId: screen.projectId,
          groupId: screen.groupId,
          expectedVersion: screen.expectedVersion,
        }),
      },
    ],
  };
}

/** Explicit Back/Cancel returns to the invoking Group menu target. */
export function cancelGroupSettings(state: DashboardState): DashboardState {
  if (state.screen.name !== "groupSettings" || state.screen.pending !== undefined) return state;
  return { ...state, screen: { name: "dashboard" } };
}

export function handleGroupSettingsKey(state: DashboardState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "groupSettings" || state.screen.pending !== undefined) return { state };
  const screen = state.screen;
  if (screen.focus === "list") return handleSectionListKey(state, screen, key);
  if (key.escape === true) {
    return { state: { ...state, screen: { ...screen, focus: "list" } } };
  }
  switch (screen.section) {
    case "general":
      return handleGeneralKey(state, screen, key);
    case "sessions":
      return handleSessionsKey(state, screen, key);
    case "remove":
      return handleRemoveKey(state, screen, key);
  }
}

/** Preserves active drafts across snapshots while pruning non-canonical sessions. */
export function reconcileGroupSettingsScreen(
  screen: GroupSettingsScreen,
  snapshot: StationSnapshot,
): GroupSettingsScreen | undefined {
  const group = snapshot.sessionGroups.find(
    (candidate) => candidate.id === screen.groupId && candidate.projectId === screen.projectId,
  );
  if (
    group === undefined ||
    !snapshot.projects.some((project) => project.id === screen.projectId)
  ) {
    return undefined;
  }
  const canonicalAssignments = groupAssignments(snapshot, screen.projectId);
  const baselineAssignments = new Map<SessionId, SessionGroupId | null>();
  const desiredSessionIds = new Set<SessionId>();
  const projectSessionIds = snapshot.sessions
    .filter((session) => session.projectId === screen.projectId)
    .map((session) => session.id);
  for (const sessionId of projectSessionIds) {
    const currentAssignment = canonicalAssignments.get(sessionId) ?? null;
    if (screen.baselineAssignments.has(sessionId)) {
      baselineAssignments.set(sessionId, screen.baselineAssignments.get(sessionId) ?? null);
      if (screen.desiredSessionIds.has(sessionId)) desiredSessionIds.add(sessionId);
    } else {
      baselineAssignments.set(sessionId, currentAssignment);
      if (currentAssignment === screen.groupId) desiredSessionIds.add(sessionId);
    }
  }
  const sessionCursor = reconciledSessionCursor(screen, projectSessionIds);
  const next: GroupSettingsScreen = {
    ...screen,
    baselineAssignments,
    desiredSessionIds,
  };
  if (sessionCursor === undefined) delete next.sessionCursor;
  else next.sessionCursor = sessionCursor;
  if (
    next.section === "sessions" &&
    next.detailFocus === "sessionList" &&
    sessionCursor === undefined
  ) {
    next.detailFocus = "sessionsBack";
  }
  return next;
}

/** Reseeds a completed editor from the latest canonical client snapshot. */
export function reseedCompletedGroupSettings(
  state: DashboardState,
  mutation: "rename" | "membership",
  groupId: SessionGroupId,
): DashboardState {
  if (
    state.screen.name !== "groupSettings" ||
    state.screen.groupId !== groupId ||
    state.snapshot === undefined
  ) {
    return state;
  }
  const section = mutation === "rename" ? "general" : "sessions";
  const seeded = seedGroupSettingsScreen(state.snapshot, groupId, section, "detail");
  if (seeded === undefined) return { ...state, screen: { name: "dashboard" } };
  seeded.detailFocus = mutation === "rename" ? "generalSave" : "membershipSave";
  return { ...state, screen: seeded };
}

export function hasGroupSettingsMembershipDelta(screen: GroupSettingsScreen): boolean {
  return membershipCommand(screen) !== undefined;
}

function seedGroupSettingsScreen(
  snapshot: StationSnapshot,
  groupId: SessionGroupId,
  section: GroupSettingsSection,
  focus: "list" | "detail",
): GroupSettingsScreen | undefined {
  const group = snapshot.sessionGroups.find((candidate) => candidate.id === groupId);
  if (group === undefined) return undefined;
  const baselineAssignments = groupAssignments(snapshot, group.projectId);
  const projectSessionIds = snapshot.sessions
    .filter((session) => session.projectId === group.projectId)
    .map((session) => session.id);
  const firstSessionId = projectSessionIds[0];
  const screen: GroupSettingsScreen = {
    name: "groupSettings",
    projectId: group.projectId,
    groupId: group.id,
    section,
    focus,
    detailFocus: initialDetailFocus(section, firstSessionId !== undefined),
    expectedVersion: group.version,
    baselineName: group.name,
    nameDraft: createEditableTextInputState(group.name),
    baselineAssignments,
    desiredSessionIds: new Set(group.sessionIds),
    removeDraft: createEditableTextInputState(),
  };
  if (firstSessionId !== undefined) screen.sessionCursor = firstSessionId;
  return screen;
}

function groupAssignments(
  snapshot: StationSnapshot,
  projectId: string,
): Map<SessionId, SessionGroupId | null> {
  const assignments = new Map<SessionId, SessionGroupId | null>();
  for (const session of snapshot.sessions) {
    if (session.projectId === projectId) assignments.set(session.id, null);
  }
  for (const group of snapshot.sessionGroups) {
    if (group.projectId !== projectId) continue;
    for (const sessionId of group.sessionIds) {
      if (assignments.has(sessionId)) assignments.set(sessionId, group.id);
    }
  }
  return assignments;
}

function membershipCommand(screen: GroupSettingsScreen) {
  const add: Array<{ sessionId: SessionId; expectedGroupId: SessionGroupId | null }> = [];
  const remove: Array<{ sessionId: SessionId; expectedGroupId: SessionGroupId | null }> = [];
  for (const [sessionId, expectedGroupId] of screen.baselineAssignments) {
    const desired = screen.desiredSessionIds.has(sessionId);
    if (desired && expectedGroupId !== screen.groupId) {
      add.push({ sessionId, expectedGroupId });
    } else if (!desired && expectedGroupId === screen.groupId) {
      remove.push({ sessionId, expectedGroupId: screen.groupId });
    }
  }
  if (add.length === 0 && remove.length === 0) return undefined;
  return buildUpdateSessionGroupMembershipDeltaCommand({
    projectId: screen.projectId,
    groupId: screen.groupId,
    expectedVersion: screen.expectedVersion,
    add,
    remove,
  });
}

function handleSectionListKey(
  state: DashboardState,
  screen: GroupSettingsScreen,
  key: TuiKey,
): TuiTransition {
  const intent = resolveSettingsPanelListIntent(GROUP_SETTINGS_ITEMS, screen.section, key, {
    closeOnLeft: true,
  });
  switch (intent.type) {
    case "close":
      return { state: cancelGroupSettings(state) };
    case "select":
      return { state: selectGroupSettingsSection(state, intent.itemId, "list") };
    case "openDetail":
      return { state: { ...state, screen: { ...screen, focus: "detail" } } };
    case "none":
      return { state };
  }
}

function handleGeneralKey(
  state: DashboardState,
  screen: GroupSettingsScreen,
  key: TuiKey,
): TuiTransition {
  if (screen.detailFocus === "name") {
    if (isReturnKey(key)) return submitGroupSettings(state);
    if (key.downArrow === true) {
      return { state: withDetailFocus(state, "generalSave") };
    }
    const intent = editableTextInputIntentForInput({ input: key.input, key });
    if (intent.type !== "edit") return { state };
    return {
      state: {
        ...state,
        screen: {
          ...screen,
          nameDraft: transitionEditableTextInput(screen.nameDraft, intent.action),
        },
      },
    };
  }
  if (key.upArrow === true) return { state: withDetailFocus(state, "name") };
  if (key.leftArrow === true || key.rightArrow === true) {
    return {
      state: withDetailFocus(
        state,
        screen.detailFocus === "generalSave" ? "generalCancel" : "generalSave",
      ),
    };
  }
  if (!isReturnKey(key)) return { state };
  return screen.detailFocus === "generalSave"
    ? submitGroupSettings(state)
    : { state: cancelGroupSettings(state) };
}

function handleSessionsKey(
  state: DashboardState,
  screen: GroupSettingsScreen,
  key: TuiKey,
): TuiTransition {
  const sessionIds = [...screen.baselineAssignments.keys()];
  if (screen.detailFocus === "sessionList") {
    if (key.leftArrow === true) {
      return { state: { ...state, screen: { ...screen, focus: "list" } } };
    }
    const slot = sessionIdForSlot(sessionIds, key.input);
    if (slot !== undefined) return { state: toggleGroupSettingsSession(state, slot) };
    if (key.input === " " || isReturnKey(key)) {
      return screen.sessionCursor === undefined
        ? { state }
        : { state: toggleGroupSettingsSession(state, screen.sessionCursor) };
    }
    if (key.upArrow === true || key.downArrow === true) {
      const index = Math.max(0, sessionIds.indexOf(screen.sessionCursor ?? sessionIds[0] ?? ""));
      if (key.downArrow === true && index >= sessionIds.length - 1) {
        return { state: withDetailFocus(state, "membershipSave") };
      }
      const next =
        sessionIds[Math.max(0, Math.min(sessionIds.length - 1, index + (key.upArrow ? -1 : 1)))];
      if (next === undefined) return { state: withDetailFocus(state, "sessionsBack") };
      return { state: { ...state, screen: { ...screen, sessionCursor: next } } };
    }
    return { state };
  }
  if (key.upArrow === true && screen.sessionCursor !== undefined) {
    return { state: withDetailFocus(state, "sessionList") };
  }
  if (key.leftArrow === true || key.rightArrow === true) {
    return {
      state: withDetailFocus(
        state,
        screen.detailFocus === "membershipSave" ? "sessionsBack" : "membershipSave",
      ),
    };
  }
  if (!isReturnKey(key)) return { state };
  return screen.detailFocus === "membershipSave"
    ? submitGroupSettings(state)
    : { state: cancelGroupSettings(state) };
}

function handleRemoveKey(
  state: DashboardState,
  screen: GroupSettingsScreen,
  key: TuiKey,
): TuiTransition {
  if (screen.detailFocus === "removeConfirm") {
    if (isReturnKey(key)) return submitGroupSettings(state);
    if (key.downArrow === true) return { state: withDetailFocus(state, "removeSubmit") };
    const intent = editableTextInputIntentForInput({ input: key.input, key });
    if (intent.type !== "edit") return { state };
    return {
      state: {
        ...state,
        screen: {
          ...screen,
          removeDraft: transitionEditableTextInput(screen.removeDraft, intent.action),
        },
      },
    };
  }
  if (key.upArrow === true) return { state: withDetailFocus(state, "removeConfirm") };
  if (key.leftArrow === true || key.rightArrow === true) {
    return {
      state: withDetailFocus(
        state,
        screen.detailFocus === "removeSubmit" ? "removeBack" : "removeSubmit",
      ),
    };
  }
  if (!isReturnKey(key)) return { state };
  return screen.detailFocus === "removeSubmit"
    ? submitGroupSettings(state)
    : { state: cancelGroupSettings(state) };
}

function withDetailFocus(
  state: DashboardState,
  detailFocus: GroupSettingsDetailFocus,
): DashboardState {
  return state.screen.name === "groupSettings"
    ? { ...state, screen: { ...state.screen, detailFocus } }
    : state;
}

function initialDetailFocus(
  section: GroupSettingsSection,
  hasSessions: boolean,
): GroupSettingsDetailFocus {
  if (section === "general") return "name";
  if (section === "sessions") return hasSessions ? "sessionList" : "sessionsBack";
  return "removeConfirm";
}

function controlBelongsToSection(
  control: GroupSettingsDetailFocus,
  section: GroupSettingsSection,
): boolean {
  if (section === "general") {
    return control === "name" || control === "generalSave" || control === "generalCancel";
  }
  if (section === "sessions") {
    return control === "sessionList" || control === "membershipSave" || control === "sessionsBack";
  }
  return control === "removeConfirm" || control === "removeSubmit" || control === "removeBack";
}

function sessionIdForSlot(sessionIds: readonly SessionId[], input: string): SessionId | undefined {
  // Arrow events carry empty input, which String#indexOf would otherwise map to slot 0.
  if (input.length !== 1) return undefined;
  const keys = "123456789abcdefghijklmnopqrstuvwxyz";
  const index = keys.indexOf(input.toLowerCase());
  return index < 0 ? undefined : sessionIds[index];
}

function reconciledSessionCursor(
  screen: GroupSettingsScreen,
  sessionIds: readonly SessionId[],
): SessionId | undefined {
  if (screen.sessionCursor !== undefined && sessionIds.includes(screen.sessionCursor)) {
    return screen.sessionCursor;
  }
  const previousIds = [...screen.baselineAssignments.keys()];
  const previousIndex = Math.max(
    0,
    previousIds.indexOf(screen.sessionCursor ?? previousIds[0] ?? ""),
  );
  return sessionIds[Math.min(previousIndex, Math.max(0, sessionIds.length - 1))];
}
