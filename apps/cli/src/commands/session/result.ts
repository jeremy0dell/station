import type {
  AcceptedCommandReceipt,
  CommandExecutionOutcome,
  CurrentSessionContext,
  RejectedCommandReceipt,
  SafeError,
  SessionCreateCommandResult,
  SessionForkCommandResult,
} from "@station/contracts";
import type { CliRunCorrelation } from "../../cliTypes.js";
import type { CloseSessionCommand, RenameSessionCommand } from "./args.js";
import type { CloseSessionConvergence, RenameSessionConvergence } from "./convergence.js";
import type { SessionCreationConvergence } from "./creationConvergence.js";
import type { SessionFilters, SessionSummary } from "./summary.js";

type SessionMutationCommand = RenameSessionCommand | CloseSessionCommand;
type TerminalCommandOutcome<TCommand extends SessionMutationCommand> = Exclude<
  CommandExecutionOutcome<TCommand>,
  { status: "accepted" }
>;

export type SessionCreationCompletion = {
  commandId: AcceptedCommandReceipt["commandId"];
  traceId?: string;
  error?: SafeError;
};

export type SessionCreationOutcome<TResult> =
  | {
      status: "rejected";
      receipt: RejectedCommandReceipt;
    }
  | {
      status: "failed";
      receipt: AcceptedCommandReceipt;
      completion: SessionCreationCompletion;
    }
  | {
      status: "succeeded";
      receipt: AcceptedCommandReceipt;
      completion: SessionCreationCompletion;
      result: TResult;
    };

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
      action: "create";
      outcome: SessionCreationOutcome<SessionCreateCommandResult>;
      convergence?: SessionCreationConvergence;
    }
  | {
      action: "fork";
      outcome: SessionCreationOutcome<SessionForkCommandResult>;
      convergence?: SessionCreationConvergence;
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
    (result.action === "create" ||
      result.action === "fork" ||
      result.action === "rename" ||
      result.action === "close") &&
    (result.outcome.status === "rejected" || result.outcome.status === "failed")
  ) {
    return 1;
  }
  return 0;
}

export function sessionCreationCorrelation(
  outcome: SessionCreationOutcome<SessionCreateCommandResult | SessionForkCommandResult>,
): CliRunCorrelation {
  const correlation: CliRunCorrelation = {
    status: outcome.status,
    commandId: outcome.receipt.commandId,
  };
  const traceId =
    outcome.receipt.traceId ??
    (outcome.status === "rejected" ? undefined : outcome.completion.traceId);
  if (traceId !== undefined) correlation.traceId = traceId;
  return correlation;
}
