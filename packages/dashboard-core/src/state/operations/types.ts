import type {
  ProjectView,
  ProviderId,
  SessionGroupId,
  SessionGroupPlacementIntent,
  SessionId,
  StationCommand,
  WorktreeId,
} from "@station/contracts";

export type ActivateSessionOperation = {
  type: "activateSession";
  sessionId: SessionId;
  projectId: string;
  worktreeId: WorktreeId;
  branch: string;
  preferredObserverAction: "focus" | "start" | "resume";
  localId?: string;
};

export type CreateManagedSessionOperation = {
  type: "createManagedSession" | "quickCreateManagedSession";
  localId: string;
  project: ProjectView;
  title: string;
  hiddenBranch: string;
  harness: ProviderId;
  targetGroupId?: SessionGroupId;
  group?: SessionGroupPlacementIntent;
};

export type ForkManagedSessionOperation = {
  type: "forkManagedSession";
  localId: string;
  project: ProjectView;
  sourceWorktreeId: WorktreeId;
  title: string;
  hiddenBranch: string;
  copyDirty: boolean;
  inheritedHarness?: ProviderId;
};

export type OpenDashboardShellOperation =
  | { type: "openDashboardShell"; target: { kind: "project"; projectId: string } }
  | { type: "openDashboardShell"; target: { kind: "session"; sessionId: SessionId } };

export type DismissDashboardOperation = { type: "dismissDashboard" };
export type ExitDashboardRendererOperation = { type: "exitDashboardRenderer"; exitCode: number };

export type RemoveWorktreeOperation = {
  type: "removeWorktree";
  localId: string;
  projectId: string;
  worktreeId: WorktreeId;
  branch: string;
  command: Extract<StationCommand, { type: "worktree.remove" }>;
};

export type RenameSessionOperation = {
  type: "renameSession";
  sessionId: SessionId;
  title: string;
  command: Extract<StationCommand, { type: "session.rename" }>;
};

export type LoadProjectDirectoryOperation = {
  type: "loadProjectDirectory";
  path: string;
};

export type ReviewProjectFolderOperation = {
  type: "reviewProjectFolder";
  path: string;
};

export type SearchProjectDirectoriesOperation = {
  type: "searchProjectDirectories";
  query: string;
};

export type AddProjectOperation = {
  type: "addProject";
  command: Extract<StationCommand, { type: "project.add" }>;
};

export type SetProjectDefaultHarnessOperation = {
  type: "setProjectDefaultHarness";
  command: Extract<StationCommand, { type: "project.setDefaultHarness" }>;
};

export type RemoveProjectOperation = {
  type: "removeProject";
  command: Extract<StationCommand, { type: "project.remove" }>;
};

export type CreateSessionGroupOperation = {
  type: "createSessionGroup";
  projectId: ProjectView["id"];
  name: string;
  quickSession: boolean;
  previousGroupIds: readonly SessionGroupId[];
  command: Extract<StationCommand, { type: "sessionGroup.create" }>;
};

export type CreateQuickSessionInGroupOperation = {
  type: "quickCreateSessionInGroup";
  localId: string;
  project: ProjectView;
  groupId: SessionGroupId;
  title: string;
  hiddenBranch: string;
  harness: ProviderId;
  fallbackCell: "identity" | "quickSession";
};

export type MoveSessionToGroupOperation = {
  type: "moveSessionToGroup";
  sessionId: SessionId;
  projectId: ProjectView["id"];
  expectedCurrentGroupId: SessionGroupId | null;
  destinationGroupId: SessionGroupId | null;
  command: Extract<StationCommand, { type: "sessionGroup.updateMembership" }>;
};

export type CreateSessionGroupForMoveOperation = {
  type: "createSessionGroupForMove";
  sessionId: SessionId;
  projectId: ProjectView["id"];
  name: string;
  previousGroupIds: readonly SessionGroupId[];
  command: Extract<StationCommand, { type: "sessionGroup.create" }>;
};

export type DashboardCapabilityOperation =
  | ActivateSessionOperation
  | CreateManagedSessionOperation
  | ForkManagedSessionOperation
  | OpenDashboardShellOperation
  | DismissDashboardOperation
  | ExitDashboardRendererOperation;

export type TuiOperation =
  | DashboardCapabilityOperation
  | RemoveWorktreeOperation
  | RenameSessionOperation
  | LoadProjectDirectoryOperation
  | ReviewProjectFolderOperation
  | SearchProjectDirectoriesOperation
  | AddProjectOperation
  | SetProjectDefaultHarnessOperation
  | RemoveProjectOperation
  | CreateSessionGroupOperation
  | CreateQuickSessionInGroupOperation
  | MoveSessionToGroupOperation
  | CreateSessionGroupForMoveOperation;
