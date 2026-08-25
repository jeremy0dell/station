import type { SessionGroupId, SessionId } from "@station/contracts";
import {
  hasGroupSettingsMembershipDelta,
  isRemoveSessionGroupArmed,
  removeSessionGroupConfirmPhrase,
} from "../../state/screens/groupSettings.js";
import type { DashboardScreenView, DashboardSnapshotView } from "../../state/types.js";

type GroupSettingsScreenView = Extract<DashboardScreenView, { name: "groupSettings" }>;

export type GroupSettingsSessionItem = {
  sessionId: SessionId;
  slot: string;
  title: string;
  activity: string;
  checked: boolean;
  focused: boolean;
  currentGroupId: SessionGroupId | null;
  currentGroupName?: string;
  membershipLabel: string;
};

export type GroupSettingsPanelModel = {
  project: {
    id: string;
    label: string;
    root: string;
  };
  group: {
    id: SessionGroupId;
    name: string;
    memberCount: number;
  };
  sessions: readonly GroupSettingsSessionItem[];
  sessionCount: number;
  membershipChanged: boolean;
  removePhrase: string;
  removeArmed: boolean;
  pending: boolean;
};

/** Pure canonical/staged content projection for the Group Settings renderer. */
export function groupSettingsPanelModel(
  snapshot: DashboardSnapshotView,
  screen: GroupSettingsScreenView,
): GroupSettingsPanelModel | undefined {
  const project = snapshot.projects.find((candidate) => candidate.id === screen.projectId);
  const group = snapshot.sessionGroups.find(
    (candidate) => candidate.id === screen.groupId && candidate.projectId === screen.projectId,
  );
  if (project === undefined || group === undefined) return undefined;

  const groupsBySessionId = new Map<SessionId, (typeof snapshot.sessionGroups)[number]>();
  for (const candidate of snapshot.sessionGroups) {
    if (candidate.projectId !== project.id) continue;
    for (const sessionId of candidate.sessionIds) groupsBySessionId.set(sessionId, candidate);
  }
  const projectSessions = snapshot.sessions.filter((session) => session.projectId === project.id);
  const keys = "123456789abcdefghijklmnopqrstuvwxyz";
  const sessions = projectSessions.map((session, index): GroupSettingsSessionItem => {
    const currentGroup = groupsBySessionId.get(session.id);
    const currentGroupId = currentGroup?.id ?? null;
    const checked = screen.desiredSessionIds.has(session.id);
    const item: GroupSettingsSessionItem = {
      sessionId: session.id,
      slot: keys[index] ?? "·",
      title: session.title,
      activity: session.status.value.replaceAll("_", " "),
      checked,
      focused:
        screen.focus === "detail" &&
        screen.detailFocus === "sessionList" &&
        screen.sessionCursor === session.id,
      currentGroupId,
      membershipLabel: sessionMembershipLabel(checked, currentGroup, screen.groupId),
    };
    if (currentGroup !== undefined) item.currentGroupName = currentGroup.name;
    return item;
  });

  return {
    project: { id: project.id, label: project.label, root: project.root },
    group: { id: group.id, name: group.name, memberCount: group.sessionIds.length },
    sessions,
    sessionCount: projectSessions.length,
    membershipChanged: hasGroupSettingsMembershipDelta(screen),
    removePhrase: removeSessionGroupConfirmPhrase(screen.baselineName),
    removeArmed: isRemoveSessionGroupArmed(screen),
    pending: screen.pending !== undefined,
  };
}

function sessionMembershipLabel(
  checked: boolean,
  currentGroup: DashboardSnapshotView["sessionGroups"][number] | undefined,
  targetGroupId: SessionGroupId,
): string {
  if (checked) {
    if (currentGroup?.id === targetGroupId) return "in this Group";
    return currentGroup === undefined ? "add on Save" : `move from ${currentGroup.name}`;
  }
  if (currentGroup?.id === targetGroupId) return "ungroup on Save";
  return currentGroup === undefined ? "ungrouped" : `in ${currentGroup.name}`;
}
