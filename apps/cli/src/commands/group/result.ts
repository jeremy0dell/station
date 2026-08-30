import type {
  CommandExecutionOutcome,
  SessionGroupCreateCommandResult,
  SessionGroupView,
  StationCommand,
} from "@station/contracts";
import type { GroupMutationConvergence } from "./convergence.js";
import type { GroupFilters } from "./summary.js";

export type CreateGroupCommand = Extract<StationCommand, { type: "sessionGroup.create" }>;
export type RenameGroupCommand = Extract<StationCommand, { type: "sessionGroup.rename" }>;
export type MembershipGroupCommand = Extract<
  StationCommand,
  { type: "sessionGroup.updateMembership" }
>;
export type ReparentGroupCommand = Extract<StationCommand, { type: "sessionGroup.reparent" }>;
export type DeleteGroupCommand = Extract<StationCommand, { type: "sessionGroup.delete" }>;
export type GroupMutationCommand =
  | CreateGroupCommand
  | RenameGroupCommand
  | MembershipGroupCommand
  | ReparentGroupCommand
  | DeleteGroupCommand;

export type CompletedGroupOutcome<TCommand extends GroupMutationCommand> = Exclude<
  CommandExecutionOutcome<TCommand>,
  { status: "accepted" }
>;
type GroupFailureOutcome<TCommand extends GroupMutationCommand> = Exclude<
  CompletedGroupOutcome<TCommand>,
  { status: "succeeded" }
>;
export type GroupSuccessOutcome<TCommand extends GroupMutationCommand> = Extract<
  CompletedGroupOutcome<TCommand>,
  { status: "succeeded" }
>;

type CreateGroupResult =
  | { action: "create"; outcome: GroupFailureOutcome<CreateGroupCommand> }
  | {
      action: "create";
      outcome: GroupSuccessOutcome<CreateGroupCommand>;
      created: SessionGroupCreateCommandResult;
      convergence: GroupMutationConvergence;
    };

type TargetGroupResult<
  TAction extends "rename" | "members.add" | "members.remove" | "reparent" | "delete",
  TCommand extends GroupMutationCommand,
> =
  | { action: TAction; target: SessionGroupView; outcome: GroupFailureOutcome<TCommand> }
  | {
      action: TAction;
      target: SessionGroupView;
      outcome: GroupSuccessOutcome<TCommand>;
      convergence: GroupMutationConvergence;
    };

export type GroupCommandResult =
  | { action: "list"; filters: GroupFilters; groups: SessionGroupView[] }
  | { action: "get"; group: SessionGroupView }
  | CreateGroupResult
  | TargetGroupResult<"rename", RenameGroupCommand>
  | TargetGroupResult<"members.add", MembershipGroupCommand>
  | TargetGroupResult<"members.remove", MembershipGroupCommand>
  | TargetGroupResult<"reparent", ReparentGroupCommand>
  | TargetGroupResult<"delete", DeleteGroupCommand>;

export function groupCommandExitCode(result: GroupCommandResult): number {
  if (!("outcome" in result)) return 0;
  return result.outcome.status === "rejected" || result.outcome.status === "failed" ? 1 : 0;
}
