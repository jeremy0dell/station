import { z } from "zod";
import { ObserverReconcileCommandSchema } from "./commands/observer.js";
import {
  AddProjectCommandSchema,
  RemoveProjectCommandSchema,
  SetProjectDefaultHarnessCommandSchema,
} from "./commands/project.js";
import {
  AcknowledgeTurnCommandSchema,
  CloseSessionCommandSchema,
  CreateSessionCommandSchema,
  ForkSessionCommandSchema,
  ImportRecoveryHandleCommandSchema,
  RenameSessionCommandSchema,
  ResumeAgentCommandSchema,
  SessionCreateCommandResultSchema,
  SessionForkCommandResultSchema,
  StartAgentCommandSchema,
} from "./commands/session.js";
import {
  CreateSessionGroupCommandSchema,
  DeleteSessionGroupCommandSchema,
  RenameSessionGroupCommandSchema,
  ReparentSessionGroupCommandSchema,
  SessionGroupCreateCommandResultSchema,
  UpdateSessionGroupMembershipCommandSchema,
} from "./commands/sessionGroup.js";
import { TerminalCloseCommandSchema, TerminalFocusCommandSchema } from "./commands/terminal.js";
import {
  CreateWorktreeCommandSchema,
  ForkWorktreeCommandSchema,
  RemoveWorktreeCommandSchema,
  WorktreeCreateCommandResultSchema,
  WorktreeForkCommandResultSchema,
} from "./commands/worktree.js";

export const StationCommandTypeSchema = z.enum([
  "worktree.create",
  "worktree.fork",
  "worktree.remove",
  "session.create",
  "session.startAgent",
  "session.resumeAgent",
  "session.importRecoveryHandle",
  "session.fork",
  "terminal.focus",
  "terminal.close",
  "session.close",
  "session.rename",
  "session.acknowledgeTurn",
  "observer.reconcile",
  "project.add",
  "project.remove",
  "project.setDefaultHarness",
  "sessionGroup.create",
  "sessionGroup.rename",
  "sessionGroup.updateMembership",
  "sessionGroup.reparent",
  "sessionGroup.delete",
]);

export const StationCommandSchema = z.discriminatedUnion("type", [
  CreateWorktreeCommandSchema,
  ForkWorktreeCommandSchema,
  RemoveWorktreeCommandSchema,
  CreateSessionCommandSchema,
  StartAgentCommandSchema,
  ResumeAgentCommandSchema,
  ImportRecoveryHandleCommandSchema,
  ForkSessionCommandSchema,
  TerminalFocusCommandSchema,
  TerminalCloseCommandSchema,
  CloseSessionCommandSchema,
  RenameSessionCommandSchema,
  AcknowledgeTurnCommandSchema,
  ObserverReconcileCommandSchema,
  AddProjectCommandSchema,
  RemoveProjectCommandSchema,
  SetProjectDefaultHarnessCommandSchema,
  CreateSessionGroupCommandSchema,
  RenameSessionGroupCommandSchema,
  UpdateSessionGroupMembershipCommandSchema,
  ReparentSessionGroupCommandSchema,
  DeleteSessionGroupCommandSchema,
]);

export type StationCommand = z.infer<typeof StationCommandSchema>;

export const StationCommandResultTypeSchema = z.enum([
  "worktree.create",
  "worktree.fork",
  "session.create",
  "session.fork",
  "sessionGroup.create",
]);

export type StationCommandResultType = z.infer<typeof StationCommandResultTypeSchema>;

export const StationCommandResultSchema = z.discriminatedUnion("type", [
  WorktreeCreateCommandResultSchema,
  WorktreeForkCommandResultSchema,
  SessionCreateCommandResultSchema,
  SessionForkCommandResultSchema,
  SessionGroupCreateCommandResultSchema,
]);

export type StationCommandResult = z.infer<typeof StationCommandResultSchema>;
export type StationCommandResultFor<TCommand extends StationCommand> = Extract<
  StationCommandResult,
  { type: TCommand["type"] }
>;
