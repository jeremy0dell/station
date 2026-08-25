import type {
  ProjectId,
  ProviderProjectConfig,
  SafeError,
  SessionGroupView,
  SessionView,
} from "@station/contracts";
import type { SessionGroupRepairEvidence, SessionGroupStore } from "../persistence/index.js";

export type SessionGroupProjection = {
  sessionGroups: SessionGroupView[];
  errors: SafeError[];
};

/**
 * USE CASE
 *
 * Repairs durable Group identity and parentage against canonical state, prunes absent membership
 * only for explicitly authoritative projects, then projects configured Groups with reason-specific
 * diagnostics.
 */
export async function reconcileSessionGroups(input: {
  store?: SessionGroupStore | undefined;
  projects: readonly ProviderProjectConfig[];
  sessions: readonly SessionView[];
  absenceAuthorityProjectIds: readonly ProjectId[];
  updatedAt: string;
}): Promise<SessionGroupProjection> {
  if (input.store === undefined) {
    return { sessionGroups: [], errors: [] };
  }

  const repaired = await input.store.repairSessionGroups({
    sessions: input.sessions.map((session) => ({ id: session.id, projectId: session.projectId })),
    absenceAuthorityProjectIds: [...input.absenceAuthorityProjectIds],
    updatedAt: input.updatedAt,
  });
  const groups = repaired.groups;
  const configuredProjectIds = new Set(input.projects.map((project) => project.id));
  const errors: SafeError[] = repaired.repairs.map((repair) => repairError(repair));
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
 * Projects configured Groups as a flat deterministic parent-before-child array with canonical direct membership.
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
      if (emitted.has(group.id)) return;
      emitted.add(group.id);
      ordered.push(group);
    };
    for (const group of projectGroups.sort((left, right) => left.id.localeCompare(right.id))) {
      emit(group);
    }
  }
  return ordered;
}

function repairError(repair: SessionGroupRepairEvidence): SafeError {
  switch (repair.reason) {
    case "invalid_membership":
      return {
        tag: "SessionGroupReconcileError",
        code: "SESSION_GROUP_MEMBERSHIP_REPAIRED",
        message: `Session Group ${repair.groupId} contained membership outside the canonical project sessions.`,
        hint: "The invalid membership was removed while the Group definition was preserved.",
        projectId: repair.projectId,
      };
    case "missing_parent":
      return {
        tag: "SessionGroupReconcileError",
        code: "SESSION_GROUP_PARENT_MISSING_REPAIRED",
        message: `Session Group ${repair.groupId} referenced a missing parent Group.`,
        hint: "The invalid parent relationship was cleared while the Group definition was preserved.",
        projectId: repair.projectId,
      };
    case "cross_project_parent":
      return {
        tag: "SessionGroupReconcileError",
        code: "SESSION_GROUP_PARENT_PROJECT_REPAIRED",
        message: `Session Group ${repair.groupId} referenced a parent Group in another project.`,
        hint: "The cross-project parent relationship was cleared while both definitions were preserved.",
        projectId: repair.projectId,
      };
    case "parent_cycle":
      return {
        tag: "SessionGroupReconcileError",
        code: "SESSION_GROUP_PARENT_CYCLE_REPAIRED",
        message: `Session Group ${repair.groupId} participated in a parent cycle.`,
        hint: "The cycle participant was moved to the project root while its definition was preserved.",
        projectId: repair.projectId,
      };
  }
}
