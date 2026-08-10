import {
  type SessionGroupId,
  type SessionGroupView,
  SessionGroupViewSchema,
} from "@station/contracts";
import type {
  SessionGroupMemberExpectation,
  SessionGroupRepairEvidence,
  SessionGroupRepairResult,
  SessionGroupStoreResult,
} from "./types.js";

type Assignment = { groupId: SessionGroupId; projectId: string };

export type SessionGroupPersistenceState = {
  groups: Map<SessionGroupId, SessionGroupView>;
  assignments: Map<string, Assignment>;
};

export type SessionGroupMutation<TResult = SessionGroupStoreResult> = {
  state: SessionGroupPersistenceState;
  result: TResult;
  changed: boolean;
};

type VersionedInput = { id: SessionGroupId; expectedVersion: number };

export function emptySessionGroupState(): SessionGroupPersistenceState {
  return { groups: new Map(), assignments: new Map() };
}

export function cloneSessionGroupState(
  state: SessionGroupPersistenceState,
): SessionGroupPersistenceState {
  return {
    groups: new Map([...state.groups].map(([id, group]) => [id, structuredClone(group)])),
    assignments: new Map(
      [...state.assignments].map(([sessionId, assignment]) => [sessionId, { ...assignment }]),
    ),
  };
}

export function listSessionGroups(state: SessionGroupPersistenceState): SessionGroupView[] {
  const byProject = new Map<string, SessionGroupView[]>();
  for (const group of state.groups.values()) {
    const sessionIds = [...state.assignments]
      .filter(([, assignment]) => assignment.groupId === group.id)
      .map(([sessionId]) => sessionId)
      .sort();
    const canonical = SessionGroupViewSchema.parse({ ...group, sessionIds });
    const projectGroups = byProject.get(group.projectId) ?? [];
    projectGroups.push(canonical);
    byProject.set(group.projectId, projectGroups);
  }

  const ordered: SessionGroupView[] = [];
  for (const projectId of [...byProject.keys()].sort()) {
    const projectGroups = byProject.get(projectId) ?? [];
    const groupsById = new Map(projectGroups.map((group) => [group.id, group]));
    const emitted = new Set<string>();
    const visiting = new Set<string>();
    const emit = (group: SessionGroupView): void => {
      if (emitted.has(group.id)) return;
      if (!visiting.has(group.id)) {
        visiting.add(group.id);
        const parent =
          group.parentGroupId === undefined ? undefined : groupsById.get(group.parentGroupId);
        if (parent !== undefined) emit(parent);
        visiting.delete(group.id);
      }
      if (emitted.has(group.id)) return;
      emitted.add(group.id);
      ordered.push(structuredClone(group));
    };
    for (const group of projectGroups.sort((left, right) => left.id.localeCompare(right.id))) {
      emit(group);
    }
  }
  return ordered;
}

export function createSessionGroup(
  state: SessionGroupPersistenceState,
  input: {
    id: SessionGroupId;
    projectId: string;
    name: string;
    initialMembers?: SessionGroupMemberExpectation[];
    parentGroupId?: SessionGroupId;
    createdAt: string;
  },
): SessionGroupMutation {
  if (state.groups.has(input.id)) return conflict(state, "already_exists");
  const draft = cloneSessionGroupState(state);
  validateUniqueExpectations(input.initialMembers ?? []);
  if (input.parentGroupId !== undefined) {
    const parent = draft.groups.get(input.parentGroupId);
    if (parent === undefined) return conflict(state, "not_found");
    if (parent.projectId !== input.projectId)
      throw new Error("Group parent must share its project.");
  }
  for (const member of input.initialMembers ?? []) {
    if (member.projectId !== input.projectId)
      throw new Error("Group members must share its project.");
    if (member.expectedGroupId !== null || draft.assignments.has(member.sessionId)) {
      return conflict(state, "unexpected_assignment");
    }
  }
  const group = SessionGroupViewSchema.parse({
    id: input.id,
    projectId: input.projectId,
    name: input.name,
    sessionIds: [],
    ...(input.parentGroupId === undefined ? {} : { parentGroupId: input.parentGroupId }),
    version: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  draft.groups.set(group.id, group);
  for (const member of input.initialMembers ?? []) {
    draft.assignments.set(member.sessionId, { groupId: group.id, projectId: member.projectId });
  }
  return success(draft, [group.id], true);
}

export function renameSessionGroup(
  state: SessionGroupPersistenceState,
  input: VersionedInput & { name: string; updatedAt: string },
): SessionGroupMutation {
  const group = expectedGroup(state, input);
  if (!group.ok) return group.mutation;
  const name = input.name.trim();
  SessionGroupViewSchema.parse({ ...group.value, name });
  if (group.value.name === name) return success(state, [group.value.id], false);
  const draft = cloneSessionGroupState(state);
  draft.groups.set(
    group.value.id,
    SessionGroupViewSchema.parse({
      ...group.value,
      name,
      version: group.value.version + 1,
      updatedAt: input.updatedAt,
    }),
  );
  return success(draft, [group.value.id], true);
}

export function updateSessionGroupMembership(
  state: SessionGroupPersistenceState,
  input: VersionedInput & {
    add?: SessionGroupMemberExpectation[];
    remove?: SessionGroupMemberExpectation[];
    updatedAt: string;
  },
): SessionGroupMutation {
  const target = expectedGroup(state, input);
  if (!target.ok) return target.mutation;
  const add = input.add ?? [];
  const remove = input.remove ?? [];
  validateUniqueExpectations([...add, ...remove]);
  const draft = cloneSessionGroupState(state);
  const touched = new Set<SessionGroupId>();

  for (const member of [...add, ...remove]) {
    const current = draft.assignments.get(member.sessionId)?.groupId ?? null;
    if (current !== member.expectedGroupId) return conflict(state, "unexpected_assignment");
    if (member.projectId !== target.value.projectId) {
      throw new Error("Group members must share its project.");
    }
  }
  for (const member of add) {
    const current = draft.assignments.get(member.sessionId);
    if (current?.groupId === target.value.id) continue;
    if (current !== undefined) touched.add(current.groupId);
    draft.assignments.set(member.sessionId, {
      groupId: target.value.id,
      projectId: member.projectId,
    });
    touched.add(target.value.id);
  }
  for (const member of remove) {
    if (member.expectedGroupId !== target.value.id) {
      throw new Error("Removed members must be expected in the target Group.");
    }
    draft.assignments.delete(member.sessionId);
    touched.add(target.value.id);
  }
  touchGroups(draft, touched, input.updatedAt);
  return success(draft, touched.size === 0 ? [target.value.id] : [...touched], touched.size > 0);
}

export function reparentSessionGroup(
  state: SessionGroupPersistenceState,
  input: VersionedInput & { parentGroupId?: SessionGroupId; updatedAt: string },
): SessionGroupMutation {
  const child = expectedGroup(state, input);
  if (!child.ok) return child.mutation;
  if (input.parentGroupId === child.value.parentGroupId) {
    return success(state, [child.value.id], false);
  }
  if (input.parentGroupId === child.value.id) throw new Error("A Group cannot parent itself.");
  if (input.parentGroupId !== undefined) {
    const parent = state.groups.get(input.parentGroupId);
    if (parent === undefined) return conflict(state, "not_found");
    if (parent.projectId !== child.value.projectId) {
      throw new Error("Group parent must share its project.");
    }
    let ancestor: SessionGroupView | undefined = parent;
    const visited = new Set<SessionGroupId>();
    while (ancestor !== undefined) {
      if (ancestor.id === child.value.id) throw new Error("Group parents must not form a cycle.");
      if (visited.has(ancestor.id)) throw new Error("Group parent ancestry must be acyclic.");
      visited.add(ancestor.id);
      if (ancestor.parentGroupId === undefined) break;
      const parentAncestor = state.groups.get(ancestor.parentGroupId);
      if (parentAncestor === undefined) {
        throw new Error("Group parent ancestry references a missing Group.");
      }
      if (parentAncestor.projectId !== child.value.projectId) {
        throw new Error("Group parent ancestry must stay within its project.");
      }
      ancestor = parentAncestor;
    }
  }
  const draft = cloneSessionGroupState(state);
  const next = { ...child.value, version: child.value.version + 1, updatedAt: input.updatedAt };
  if (input.parentGroupId === undefined) delete next.parentGroupId;
  else next.parentGroupId = input.parentGroupId;
  draft.groups.set(next.id, SessionGroupViewSchema.parse(next));
  return success(draft, [next.id], true);
}

export function deleteSessionGroup(
  state: SessionGroupPersistenceState,
  input: VersionedInput & { updatedAt: string },
): SessionGroupMutation {
  const deleted = expectedGroup(state, input);
  if (!deleted.ok) return deleted.mutation;
  const draft = cloneSessionGroupState(state);
  draft.groups.delete(deleted.value.id);
  for (const [sessionId, assignment] of draft.assignments) {
    if (assignment.groupId === deleted.value.id) draft.assignments.delete(sessionId);
  }
  const touched = new Set<SessionGroupId>();
  for (const group of draft.groups.values()) {
    if (group.parentGroupId !== deleted.value.id) continue;
    const next = { ...group, version: group.version + 1, updatedAt: input.updatedAt };
    if (deleted.value.parentGroupId === undefined) delete next.parentGroupId;
    else next.parentGroupId = deleted.value.parentGroupId;
    draft.groups.set(group.id, SessionGroupViewSchema.parse(next));
    touched.add(group.id);
  }
  return success(draft, [...touched], true);
}

export function repairSessionGroups(
  state: SessionGroupPersistenceState,
  input: { sessions: Array<{ id: string; projectId: string }>; updatedAt: string },
): SessionGroupMutation<SessionGroupRepairResult> {
  const validSessions = new Map(input.sessions.map((session) => [session.id, session.projectId]));
  const draft = cloneSessionGroupState(state);
  const touched = new Set<SessionGroupId>();
  const repairs: SessionGroupRepairEvidence[] = [];
  const repairKeys = new Set<string>();
  const recordRepair = (repair: SessionGroupRepairEvidence): void => {
    const key = `${repair.groupId}\u0000${repair.reason}`;
    if (repairKeys.has(key)) return;
    repairKeys.add(key);
    repairs.push(repair);
  };
  for (const [sessionId, assignment] of draft.assignments) {
    const group = draft.groups.get(assignment.groupId);
    if (group === undefined) {
      throw new Error("Session Group assignment references a missing Group.");
    }
    if (
      validSessions.get(sessionId) !== group.projectId ||
      assignment.projectId !== group.projectId
    ) {
      draft.assignments.delete(sessionId);
      touched.add(group.id);
      recordRepair({
        reason: "invalid_membership",
        groupId: group.id,
        projectId: group.projectId,
      });
    }
  }

  const orderedGroups = [...draft.groups.values()].sort(
    (left, right) =>
      left.projectId.localeCompare(right.projectId) || left.id.localeCompare(right.id),
  );
  for (const group of orderedGroups) {
    if (group.parentGroupId === undefined) continue;
    const parent = draft.groups.get(group.parentGroupId);
    const reason =
      parent === undefined
        ? "missing_parent"
        : parent.projectId !== group.projectId
          ? "cross_project_parent"
          : undefined;
    if (reason === undefined) continue;
    const next = { ...group };
    delete next.parentGroupId;
    draft.groups.set(group.id, SessionGroupViewSchema.parse(next));
    touched.add(group.id);
    recordRepair({
      reason,
      groupId: group.id,
      projectId: group.projectId,
      parentGroupId: group.parentGroupId,
    });
  }

  const resolved = new Set<SessionGroupId>();
  for (const start of orderedGroups) {
    if (resolved.has(start.id)) continue;
    const path: SessionGroupId[] = [];
    const pathIndex = new Map<SessionGroupId, number>();
    let currentId: SessionGroupId | undefined = start.id;
    while (currentId !== undefined && !resolved.has(currentId)) {
      const cycleStart = pathIndex.get(currentId);
      if (cycleStart !== undefined) {
        // Root only cycle participants so incoming non-cycle descendants keep their repaired attachment.
        for (const groupId of path.slice(cycleStart)) {
          const group = draft.groups.get(groupId);
          if (group?.parentGroupId === undefined) {
            throw new Error("Session Group cycle repair lost its parent edge.");
          }
          const parentGroupId = group.parentGroupId;
          const next = { ...group };
          delete next.parentGroupId;
          draft.groups.set(group.id, SessionGroupViewSchema.parse(next));
          touched.add(group.id);
          recordRepair({
            reason: "parent_cycle",
            groupId: group.id,
            projectId: group.projectId,
            parentGroupId,
          });
        }
        break;
      }
      pathIndex.set(currentId, path.length);
      path.push(currentId);
      const group = draft.groups.get(currentId);
      if (group === undefined) throw new Error("Session Group parent references a missing Group.");
      currentId = group.parentGroupId;
    }
    for (const groupId of path) resolved.add(groupId);
  }

  touchGroups(draft, touched, input.updatedAt);
  const reasonOrder = {
    invalid_membership: 0,
    missing_parent: 1,
    cross_project_parent: 2,
    parent_cycle: 3,
  } as const;
  repairs.sort(
    (left, right) =>
      left.projectId.localeCompare(right.projectId) ||
      left.groupId.localeCompare(right.groupId) ||
      reasonOrder[left.reason] - reasonOrder[right.reason],
  );
  return {
    state: draft,
    changed: touched.size > 0,
    result: { groups: listSessionGroups(draft), repairs },
  };
}

function expectedGroup(
  state: SessionGroupPersistenceState,
  input: VersionedInput,
): { ok: true; value: SessionGroupView } | { ok: false; mutation: SessionGroupMutation } {
  const group = state.groups.get(input.id);
  if (group === undefined) return { ok: false, mutation: conflict(state, "not_found") };
  if (group.version !== input.expectedVersion) {
    return { ok: false, mutation: conflict(state, "stale_version") };
  }
  return { ok: true, value: group };
}

function touchGroups(
  state: SessionGroupPersistenceState,
  ids: ReadonlySet<SessionGroupId>,
  updatedAt: string,
): void {
  for (const id of ids) {
    const group = state.groups.get(id);
    if (group === undefined)
      throw new Error("Session Group assignment references a missing Group.");
    state.groups.set(
      id,
      SessionGroupViewSchema.parse({ ...group, version: group.version + 1, updatedAt }),
    );
  }
}

function validateUniqueExpectations(expectations: SessionGroupMemberExpectation[]): void {
  if (new Set(expectations.map((member) => member.sessionId)).size !== expectations.length) {
    throw new Error("A membership update may mention each session only once.");
  }
}

function success(
  state: SessionGroupPersistenceState,
  affectedIds: SessionGroupId[],
  changed: boolean,
): SessionGroupMutation {
  const affected = new Set(affectedIds);
  return {
    state,
    changed,
    result: {
      ok: true,
      groups: listSessionGroups(state).filter((group) => affected.has(group.id)),
    },
  };
}

function conflict(
  state: SessionGroupPersistenceState,
  reason: Exclude<SessionGroupStoreResult, { ok: true }>["reason"],
): SessionGroupMutation {
  return { state, changed: false, result: { ok: false, reason } };
}
