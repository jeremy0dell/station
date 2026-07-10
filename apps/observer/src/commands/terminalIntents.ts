import type {
  ProviderId,
  SafeError,
  SessionView,
  StationSnapshot,
  TerminalCloseIntent,
  TerminalClosePayload,
  TerminalFocusIntent,
  TerminalFocusPayload,
  TerminalIntent,
  TerminalIntentReceipt,
  TerminalIntentSubject,
  WorktreeRow,
} from "@station/contracts";
import { resolveRowForSession } from "./cleanup/resolve.js";
import type { CommandHandlerContext } from "./queue.js";
import type { TerminalIntentRunner } from "./terminalIntentRunner.js";

export function terminalFocusIntentFromPayload(input: {
  defaultTerminalId: ProviderId;
  commandId: string;
  payload: TerminalFocusPayload;
  snapshot?: StationSnapshot | undefined;
}): TerminalFocusIntent {
  const intent: TerminalFocusIntent = {
    type: "terminal.focus",
    commandId: input.commandId,
    terminalProvider: resolveTerminalProviderFromPayload(
      input.payload,
      input.snapshot,
      input.defaultTerminalId,
    ),
    subject: terminalIntentSubjectFromPayload(input.payload, input.snapshot),
  };
  if (input.payload.origin !== undefined) {
    intent.origin = input.payload.origin;
  }
  return intent;
}

export function terminalCloseIntentFromPayload(input: {
  defaultTerminalId: ProviderId;
  commandId: string;
  payload: TerminalClosePayload;
  snapshot?: StationSnapshot | undefined;
}): TerminalCloseIntent {
  const intent: TerminalCloseIntent = {
    type: "terminal.close",
    commandId: input.commandId,
    terminalProvider: resolveTerminalProviderFromPayload(
      input.payload,
      input.snapshot,
      input.defaultTerminalId,
    ),
    subject: terminalIntentSubjectFromPayload(input.payload, input.snapshot),
  };
  if (input.payload.force !== undefined) {
    intent.force = input.payload.force;
  }
  return intent;
}

export function terminalCloseIntentForSession(input: {
  defaultTerminalId: ProviderId;
  commandId: string;
  session: SessionView;
  row?: WorktreeRow | undefined;
  force: boolean;
}): TerminalCloseIntent {
  const intent: TerminalCloseIntent = {
    type: "terminal.close",
    commandId: input.commandId,
    terminalProvider:
      input.session.terminal?.provider ?? input.row?.terminal?.provider ?? input.defaultTerminalId,
    subject: terminalIntentSubjectForSession(input.session, input.row),
  };
  if (input.force) {
    intent.force = true;
  }
  return intent;
}

export function terminalCloseIntentForWorktree(input: {
  defaultTerminalId: ProviderId;
  commandId: string;
  row: WorktreeRow;
  force: boolean;
}): TerminalCloseIntent {
  const intent: TerminalCloseIntent = {
    type: "terminal.close",
    commandId: input.commandId,
    terminalProvider: input.row.terminal?.provider ?? input.defaultTerminalId,
    subject: terminalIntentSubjectForWorktree(input.row),
  };
  if (input.force) {
    intent.force = true;
  }
  return intent;
}

export async function submitTerminalIntentOrThrow(input: {
  terminalIntentRunner: TerminalIntentRunner;
  intent: TerminalIntent;
  context: CommandHandlerContext;
  commandTimeoutMs?: number | undefined;
}): Promise<TerminalIntentReceipt> {
  const receipt = await input.terminalIntentRunner.submitIntent(input.intent, {
    signal: input.context.signal,
    trace: input.context.trace,
    commandTimeoutMs: input.commandTimeoutMs,
  });
  if (receipt.status === "rejected") {
    throw receipt.error;
  }
  return receipt;
}

export function terminalIntentSubjectForSession(
  session: SessionView,
  row?: WorktreeRow | undefined,
): TerminalIntentSubject {
  const subject: TerminalIntentSubject = {
    sessionId: session.id,
    worktreeId: session.worktreeId,
    projectId: session.projectId,
  };
  if (row?.id !== undefined) subject.worktreeId = row.id;
  if (row?.projectId !== undefined) subject.projectId = row.projectId;
  return subject;
}

export function terminalIntentSubjectForWorktree(row: WorktreeRow): TerminalIntentSubject {
  const subject: TerminalIntentSubject = {
    worktreeId: row.id,
    projectId: row.projectId,
  };
  if (row.agent?.sessionId !== undefined) {
    subject.sessionId = row.agent.sessionId;
  }
  return subject;
}

export function hasCloseableTerminalAttachment(input: {
  session?: SessionView | undefined;
  row?: WorktreeRow | undefined;
}): boolean {
  if (terminalAttachmentIsCloseable(input.session?.terminal)) {
    return true;
  }
  return terminalAttachmentIsCloseable(input.row?.terminal);
}

function terminalAttachmentIsCloseable(
  terminal: SessionView["terminal"] | WorktreeRow["terminal"] | undefined,
): boolean {
  if (terminal === undefined) {
    return false;
  }
  if (terminal.closeable === true) {
    return true;
  }
  // This controls whether to show/submit the product close action. The terminal
  // intent runner still validates the provider target and may report stale state.
  return (
    terminal.state === "open" ||
    terminal.state === "detached" ||
    terminal.state === "unknown" ||
    terminal.state === "stale"
  );
}

/**
 * Route focus/close to the provider that owns the payload's attachment, not
 * always the default terminal provider.
 */
function resolveTerminalProviderFromPayload(
  payload: TerminalFocusPayload | TerminalClosePayload,
  snapshot: StationSnapshot | undefined,
  fallback: string,
): string {
  if (snapshot === undefined) {
    return fallback;
  }
  if (payload.sessionId !== undefined) {
    const session = snapshot.sessions.find((candidate) => candidate.id === payload.sessionId);
    if (session?.terminal?.provider !== undefined) {
      return session.terminal.provider;
    }
    const row =
      session !== undefined
        ? resolveRowForSession(snapshot, session)
        : snapshot.rows.find((candidate) => candidate.id === payload.worktreeId);
    return row?.terminal?.provider ?? fallback;
  }
  if (payload.worktreeId !== undefined) {
    const row = snapshot.rows.find((candidate) => candidate.id === payload.worktreeId);
    return row?.terminal?.provider ?? fallback;
  }
  return fallback;
}

function terminalIntentSubjectFromPayload(
  payload: TerminalFocusPayload | TerminalClosePayload,
  snapshot: StationSnapshot | undefined,
): TerminalIntentSubject {
  if (payload.sessionId !== undefined) {
    if (snapshot !== undefined) {
      const session = snapshot.sessions.find((candidate) => candidate.id === payload.sessionId);
      if (session !== undefined) {
        return terminalIntentSubjectForSession(session, resolveRowForSession(snapshot, session));
      }
    }
    const subject: TerminalIntentSubject = {
      sessionId: payload.sessionId,
    };
    if (payload.worktreeId !== undefined) subject.worktreeId = payload.worktreeId;
    return subject;
  }

  if (payload.worktreeId !== undefined) {
    const row = snapshot?.rows.find((candidate) => candidate.id === payload.worktreeId);
    if (row !== undefined) {
      return terminalIntentSubjectForWorktree(row);
    }
    return {
      worktreeId: payload.worktreeId,
    };
  }

  throw terminalIntentSubjectMissingError();
}

function terminalIntentSubjectMissingError(): SafeError {
  return {
    tag: "CommandValidationError",
    code: "TERMINAL_INTENT_SUBJECT_MISSING",
    message: "Terminal commands require a session or worktree reference.",
  };
}
