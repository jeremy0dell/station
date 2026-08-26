import type { CommandExecutionOutcome, CurrentSessionContext } from "@station/contracts";
import type { CloseSessionCommand, RenameSessionCommand } from "./args.js";
import type { CloseSessionConvergence, RenameSessionConvergence } from "./convergence.js";
import type { SessionFilters, SessionSummary } from "./summary.js";

type SessionMutationCommand = RenameSessionCommand | CloseSessionCommand;
type TerminalCommandOutcome<TCommand extends SessionMutationCommand> = Exclude<
  CommandExecutionOutcome<TCommand>,
  { status: "accepted" }
>;

export type SessionCommandResult =
  | {
      action: "current";
      context: CurrentSessionContext;
    }
  | {
      action: "list";
      filters: SessionFilters;
      sessions: SessionSummary[];
    }
  | {
      action: "get";
      session: SessionSummary;
    }
  | {
      action: "rename";
      target: SessionSummary;
      outcome: TerminalCommandOutcome<RenameSessionCommand>;
      convergence?: RenameSessionConvergence;
    }
  | {
      action: "close";
      target: SessionSummary;
      outcome: TerminalCommandOutcome<CloseSessionCommand>;
      convergence?: CloseSessionConvergence;
    };

export function sessionCommandExitCode(result: SessionCommandResult): number {
  if (
    (result.action === "rename" || result.action === "close") &&
    (result.outcome.status === "rejected" || result.outcome.status === "failed")
  ) {
    return 1;
  }
  return 0;
}
