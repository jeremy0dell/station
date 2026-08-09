import type {
  ProviderProjectConfig,
  SafeError,
  SessionGroupView,
  SessionView,
} from "@station/contracts";
import type { SessionGroupStore } from "../persistence/index.js";

export type SessionGroupProjection = {
  sessionGroups: SessionGroupView[];
  errors: SafeError[];
};

/**
 * USE CASE
 *
 * Repairs durable Group membership against canonical sessions and projects configured Groups.
 */
export async function refreshDurableSessionGroups(input: {
  store?: SessionGroupStore | undefined;
  projects: readonly ProviderProjectConfig[];
  sessions: readonly SessionView[];
  updatedAt: string;
}): Promise<SessionGroupProjection> {
  if (input.store === undefined) {
    return { sessionGroups: [], errors: [] };
  }

  const pruned = await input.store.pruneSessionGroupMemberships({
    sessions: input.sessions.map((session) => ({ id: session.id, projectId: session.projectId })),
    updatedAt: input.updatedAt,
  });
  if (!pruned.ok) {
    throw new Error(`Unexpected Session Group prune conflict: ${pruned.reason}`);
  }

  const groups = await input.store.listSessionGroups();
  const configuredProjectIds = new Set(input.projects.map((project) => project.id));
  const errors: SafeError[] = pruned.groups.map((group) => ({
    tag: "SessionGroupReconcileError",
    code: "SESSION_GROUP_MEMBERSHIP_REPAIRED",
    message: `Session Group ${group.id} contained membership outside the canonical project sessions.`,
    hint: "The invalid membership was removed while the Group definition was preserved.",
    projectId: group.projectId,
  }));
  for (const group of groups) {
    if (configuredProjectIds.has(group.projectId)) continue;
    errors.push({
      tag: "SessionGroupReconcileError",
      code: "SESSION_GROUP_PROJECT_EXCLUDED",
      message: `Session Group ${group.id} belongs to a project that is no longer configured.`,
      hint: "The durable Group definition was retained but excluded from the canonical snapshot.",
      projectId: group.projectId,
    });
  }

  return {
    sessionGroups: projectSessionGroups({
      groups,
      projects: input.projects,
      sessions: input.sessions,
    }),
    errors,
  };
}

/**
 * POLICY
 *
 * Selects configured Groups and orders their canonical direct membership deterministically.
 */
export function projectSessionGroups(input: {
  groups: readonly SessionGroupView[];
  projects: readonly ProviderProjectConfig[];
  sessions: readonly SessionView[];
}): SessionGroupView[] {
  const configuredProjectIds = new Set(input.projects.map((project) => project.id));
  const sessions = new Map(input.sessions.map((session) => [session.id, session]));
  const groups = input.groups
    .filter((group) => configuredProjectIds.has(group.projectId))
    .map((group) => ({
      ...group,
      sessionIds: group.sessionIds
        .filter((sessionId) => sessions.get(sessionId)?.projectId === group.projectId)
        .sort(),
    }));
  const groupsByProject = new Map<string, SessionGroupView[]>();
  for (const group of groups) {
    const projectGroups = groupsByProject.get(group.projectId) ?? [];
    projectGroups.push(group);
    groupsByProject.set(group.projectId, projectGroups);
  }

  const ordered: SessionGroupView[] = [];
  for (const projectId of [...groupsByProject.keys()].sort()) {
    const projectGroups = groupsByProject.get(projectId) ?? [];
    const groupsById = new Map(projectGroups.map((group) => [group.id, group]));
    const emitted = new Set<string>();
    const visiting = new Set<string>();
    const emit = (group: SessionGroupView): void => {
      if (emitted.has(group.id)) return;
      if (!visiting.has(group.id)) {
        visiting.add(group.id);
        const parent =
          group.parentGroupId === undefined ? undefined : groupsById.get(group.parentGroupId);
        if (parent !== undefined && parent.projectId === group.projectId) emit(parent);
        visiting.delete(group.id);
      }
      emitted.add(group.id);
      ordered.push(group);
    };
    for (const group of projectGroups.sort((left, right) => left.id.localeCompare(right.id))) {
      emit(group);
    }
  }
  return ordered;
}
