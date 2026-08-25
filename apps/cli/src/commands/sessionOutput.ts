import type { SafeError } from "@station/contracts";
import { escapeTerminalBytes } from "../terminalOutput.js";
import type {
  CloseSessionConvergence,
  RenameSessionConvergence,
  SessionCommandResult,
  SessionProjectionState,
  SessionWorktreeProjectionState,
} from "./session.js";
import type { SessionFilters, SessionSummary } from "./sessionSummary.js";

type RenderableSessionCommandResult = Exclude<SessionCommandResult, { action: "current" }>;

export function renderSessionCommandText(result: RenderableSessionCommandResult): string {
  if (result.action === "list") return renderSessionList(result.filters, result.sessions);
  if (result.action === "get") return renderSessionSummary(result.session);

  const lines = [
    `Session ${result.action}: ${escapeTerminalBytes(result.target.sessionId)}`,
    `Project: ${escapeTerminalBytes(result.target.projectId)}`,
    `Worktree: ${escapeTerminalBytes(result.target.worktreeId)}`,
    ...renderOutcome(result.outcome),
  ];
  if (result.convergence !== undefined) {
    lines.push("", ...renderConvergence(result.convergence));
  }
  return lines.join("\n");
}

export function renderSessionSummary(session: SessionSummary): string {
  const lines = [
    `${escapeTerminalBytes(session.sessionId)}  ${escapeTerminalBytes(session.title)}`,
    `  origin: ${escapeTerminalBytes(session.origin)}`,
    `  project: ${escapeTerminalBytes(session.projectId)} (${escapeTerminalBytes(session.projectLabel)})`,
    `  worktree: ${escapeTerminalBytes(session.worktreeId)}`,
    `  worktree title: ${escapeTerminalBytes(session.worktreeTitle)}`,
    `  branch: ${escapeTerminalBytes(session.branch)}`,
    `  path: ${escapeTerminalBytes(session.path)}`,
    `  created: ${escapeTerminalBytes(session.createdAt)}`,
    `  updated: ${escapeTerminalBytes(session.updatedAt)}`,
    `  tags: ${session.tags.length === 0 ? "(none)" : session.tags.map(escapeTerminalBytes).join(", ")}`,
    `  harness provider: ${escapeTerminalBytes(session.harness.provider)}`,
    `  harness mode: ${escapeTerminalBytes(session.harness.mode)}`,
  ];
  if (session.harness.pid !== undefined) lines.push(`  harness pid: ${session.harness.pid}`);
  if (session.harness.runId !== undefined) {
    lines.push(`  harness run: ${escapeTerminalBytes(session.harness.runId)}`);
  }
  lines.push(
    `  harness capabilities: ${renderCapabilities(session.harness.capabilities)}`,
    `  status: ${escapeTerminalBytes(session.status.value)}`,
    `  status confidence: ${escapeTerminalBytes(session.status.confidence)}`,
    `  status source: ${escapeTerminalBytes(session.status.source)}`,
    `  status reason: ${escapeTerminalBytes(session.status.reason)}`,
    `  status updated: ${escapeTerminalBytes(session.status.updatedAt)}`,
  );
  if (session.status.attention !== undefined) {
    lines.push(`  status attention: ${escapeTerminalBytes(session.status.attention)}`);
  }
  if (session.terminal === undefined) {
    lines.push("  terminal: (none)");
  } else {
    lines.push(
      `  terminal provider: ${escapeTerminalBytes(session.terminal.provider)}`,
      `  terminal state: ${escapeTerminalBytes(session.terminal.state)}`,
    );
    appendOptionalBoolean(lines, "terminal focusable", session.terminal.focusable);
    appendOptionalBoolean(lines, "terminal closeable", session.terminal.closeable);
    appendOptionalBoolean(lines, "terminal workspace", session.terminal.hasWorkspace);
    appendOptionalBoolean(
      lines,
      "terminal primary agent endpoint",
      session.terminal.hasPrimaryAgentEndpoint,
    );
    if (session.terminal.confidence !== undefined) {
      lines.push(`  terminal confidence: ${escapeTerminalBytes(session.terminal.confidence)}`);
    }
    if (session.terminal.reason !== undefined) {
      lines.push(`  terminal reason: ${escapeTerminalBytes(session.terminal.reason)}`);
    }
    if (session.terminal.observedAt !== undefined) {
      lines.push(`  terminal observed: ${escapeTerminalBytes(session.terminal.observedAt)}`);
    }
  }
  return lines.join("\n");
}

function renderSessionList(filters: SessionFilters, sessions: readonly SessionSummary[]): string {
  const lines: string[] = [];
  const renderedFilters = renderFilters(filters);
  if (renderedFilters !== undefined) lines.push(`Filters: ${renderedFilters}`, "");
  if (sessions.length === 0) {
    lines.push("No sessions matched.");
    return lines.join("\n");
  }
  for (const [index, session] of sessions.entries()) {
    if (index > 0) lines.push("");
    lines.push(renderSessionSummary(session));
  }
  return lines.join("\n");
}

function renderFilters(filters: SessionFilters): string | undefined {
  const values: string[] = [];
  if (filters.project !== undefined) {
    values.push(`project=${escapeTerminalBytes(filters.project)}`);
  }
  if (filters.provider !== undefined) {
    values.push(`provider=${escapeTerminalBytes(filters.provider)}`);
  }
  if (filters.status !== undefined) values.push(`status=${escapeTerminalBytes(filters.status)}`);
  if (filters.origin !== undefined) values.push(`origin=${escapeTerminalBytes(filters.origin)}`);
  if (filters.query !== undefined) values.push(`query=${escapeTerminalBytes(filters.query)}`);
  return values.length === 0 ? undefined : values.join(", ");
}

function renderCapabilities(capabilities: SessionSummary["harness"]["capabilities"]): string {
  return Object.entries(capabilities)
    .map(([name, enabled]) => `${escapeTerminalBytes(name)}=${enabled}`)
    .join(", ");
}

function appendOptionalBoolean(lines: string[], label: string, value: boolean | undefined): void {
  if (value !== undefined) lines.push(`  ${label}: ${value}`);
}

function renderOutcome(
  outcome: Extract<
    Extract<SessionCommandResult, { action: "rename" | "close" }>["outcome"],
    { status: string }
  >,
): string[] {
  const lines = [
    `Outcome: ${escapeTerminalBytes(outcome.status)}`,
    `Command: ${escapeTerminalBytes(outcome.receipt.commandId)}`,
  ];
  if (outcome.receipt.traceId !== undefined) {
    lines.push(`Trace: ${escapeTerminalBytes(outcome.receipt.traceId)}`);
  }
  if (outcome.status === "rejected" && outcome.receipt.error !== undefined) {
    lines.push(...renderWarning("Error", outcome.receipt.error));
  }
  if (outcome.status === "failed" && outcome.record.error !== undefined) {
    lines.push(...renderWarning("Error", outcome.record.error));
  }
  return lines;
}

function renderConvergence(
  convergence: RenameSessionConvergence | CloseSessionConvergence,
): string[] {
  const lines = [
    `Convergence: ${escapeTerminalBytes(convergence.status)}`,
    ...renderSessionProjectionState(convergence.session),
  ];
  if ("worktree" in convergence) {
    lines.push(...renderWorktreeProjectionState(convergence.worktree));
  }
  if (convergence.warning !== undefined) {
    lines.push(...renderWarning("Warning", convergence.warning));
  }
  return lines;
}

function renderSessionProjectionState(state: SessionProjectionState): string[] {
  if (state.state !== "present") return [`Session state: ${state.state}`];
  return ["Session state: present", renderSessionSummary(state.value)];
}

function renderWorktreeProjectionState(state: SessionWorktreeProjectionState): string[] {
  if (state.state !== "present") return [`Worktree state: ${state.state}`];
  return [
    "Worktree state: present",
    `Worktree: ${escapeTerminalBytes(state.value.worktreeId)}  ${escapeTerminalBytes(state.value.title)}`,
    `  branch: ${escapeTerminalBytes(state.value.branch)}`,
    `  path: ${escapeTerminalBytes(state.value.path)}`,
  ];
}

function renderWarning(label: "Error" | "Warning", error: SafeError): string[] {
  const lines = [
    `${label}: ${escapeTerminalBytes(error.message)} (${escapeTerminalBytes(error.code)})`,
  ];
  if (error.hint !== undefined) lines.push(`Hint: ${escapeTerminalBytes(error.hint)}`);
  return lines;
}
