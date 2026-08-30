import type {
  ProjectId,
  SafeError,
  SessionGroupId,
  SessionGroupView,
  SessionId,
} from "@station/contracts";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import type { ObserverProcessDeps } from "../../observerProcess.js";
import { loadObserverSnapshot, type ObserverSnapshotLoadOptions } from "../snapshot.js";
import { projectGroups, sameSessionIds } from "./summary.js";

export type GroupMutationConvergence = {
  status: "confirmed" | "warning";
  projectId: ProjectId;
  groups?: SessionGroupView[];
  warning?: SafeError;
};

type GroupExpectationTarget = { projectId: ProjectId; groupId: SessionGroupId };

export type GroupConvergenceExpectation = GroupExpectationTarget &
  (
    | {
        action: "create";
        name: string;
        sessionIds: readonly SessionId[];
        version: number;
      }
    | { action: "rename"; name: string; minimumVersion: number }
    | {
        action: "members.add" | "members.remove";
        sessionIds: readonly SessionId[];
        minimumVersion: number;
      }
    | { action: "reparent"; parentGroupId?: SessionGroupId; minimumVersion: number }
    | {
        action: "delete";
        directSessionIds: readonly SessionId[];
        childGroupIds: readonly SessionGroupId[];
        parentGroupId?: SessionGroupId;
      }
  );

export async function loadGroupConvergence(
  expectation: GroupConvergenceExpectation,
  options: ObserverSnapshotLoadOptions,
  deps: ObserverProcessDeps,
): Promise<GroupMutationConvergence> {
  try {
    const snapshot = await loadObserverSnapshot(options, deps);
    const groups = projectGroups(snapshot, expectation.projectId);
    if (groupExpectationConverged(expectation, groups)) {
      return { status: "confirmed", projectId: expectation.projectId, groups };
    }
    return {
      status: "warning",
      projectId: expectation.projectId,
      groups,
      warning: projectionMismatchError(expectation),
    };
  } catch (error) {
    const warning = publicSafeErrorFromUnknown(error, {
      tag: "GroupCliError",
      code: `GROUP_${convergenceAction(expectation)}_CONVERGENCE_REFRESH_FAILED`,
      message: "The Group command succeeded, but Station could not load the refreshed snapshot.",
    });
    if (warning.projectId === undefined) warning.projectId = expectation.projectId;
    warning.hint ??= `Inspect the current Group projection with \`${groupInspectionCommand(expectation)}\`.`;
    return { status: "warning", projectId: expectation.projectId, warning };
  }
}

function groupExpectationConverged(
  expectation: GroupConvergenceExpectation,
  groups: readonly SessionGroupView[],
): boolean {
  if (expectation.action === "delete") {
    if (groups.some((group) => group.id === expectation.groupId)) return false;
    if (
      expectation.childGroupIds.some((childGroupId) => {
        const child = groups.find((group) => group.id === childGroupId);
        return child === undefined || child.parentGroupId !== expectation.parentGroupId;
      })
    ) {
      return false;
    }
    return !groups.some((group) =>
      expectation.directSessionIds.some((sessionId) => group.sessionIds.includes(sessionId)),
    );
  }

  const group = groups.find((candidate) => candidate.id === expectation.groupId);
  if (group === undefined) return false;
  switch (expectation.action) {
    case "create":
      return (
        group.version >= expectation.version &&
        group.name === expectation.name &&
        group.parentGroupId === undefined &&
        sameSessionIds(group.sessionIds, expectation.sessionIds)
      );
    case "rename":
      return group.version >= expectation.minimumVersion && group.name === expectation.name;
    case "members.add":
      return (
        group.version >= expectation.minimumVersion &&
        expectation.sessionIds.every((sessionId) => group.sessionIds.includes(sessionId))
      );
    case "members.remove":
      return (
        group.version >= expectation.minimumVersion &&
        expectation.sessionIds.every((sessionId) => !group.sessionIds.includes(sessionId))
      );
    case "reparent":
      return (
        group.version >= expectation.minimumVersion &&
        group.parentGroupId === expectation.parentGroupId
      );
  }
}

function projectionMismatchError(expectation: GroupConvergenceExpectation): SafeError {
  const action = convergenceAction(expectation);
  return {
    tag: "GroupCliError",
    code: `GROUP_${action}_CONVERGENCE_MISMATCH`,
    message: `The Group ${expectation.action.replace(".", " ")} command succeeded, but the refreshed snapshot did not preserve the expected Group projection.`,
    hint: `Inspect the refreshed Group state before retrying. Use \`${groupInspectionCommand(expectation)}\`.`,
    projectId: expectation.projectId,
  };
}

function convergenceAction(expectation: GroupConvergenceExpectation): string {
  return expectation.action.toUpperCase().replace(".", "_");
}

function groupInspectionCommand(expectation: GroupConvergenceExpectation): string {
  return expectation.action === "delete"
    ? `stn group list --project ${expectation.projectId} --json`
    : `stn group get ${expectation.groupId} --json`;
}
