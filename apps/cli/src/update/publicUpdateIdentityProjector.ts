import {
  type SafeError,
  type UpdateActionAudit,
  type UpdateCommandReport,
  UpdateCommandReportSchema,
  type UpdateEvidencePlan,
  type UpdateReapPreviewConsequences,
  type UpdateReapRecoveryPreflight,
} from "@station/contracts";

type IdentityNamespace =
  | "command"
  | "diagnostic"
  | "project"
  | "pty"
  | "pty-instance"
  | "session"
  | "terminal"
  | "trace"
  | "worktree";

type IdentitySets = Record<IdentityNamespace, Set<string>>;
type IdentityAliases = Record<IdentityNamespace, Map<string, string>>;

const aliasWidth = 8;

/**
 * ADAPTER
 *
 * Projects every public opaque identity through one namespace-aware, order-preserving alias table.
 * Existing aliases remain stable when a successor report crosses the parent boundary again.
 */
export function projectPublicUpdateReportIdentities(
  input: UpdateCommandReport,
): UpdateCommandReport {
  const report = structuredClone(UpdateCommandReportSchema.parse(input));
  const sets = identitySets();
  collectEvidence(report.initial, sets);
  collectResult(report, sets);
  report.warnings.forEach((error) => {
    collectSafeError(error, sets);
  });
  if (report.error !== undefined) collectSafeError(report.error, sets);
  if (report.cause !== undefined) collectSafeError(report.cause, sets);
  const aliases = identityAliases(sets);
  projectArtifactApplicationCommands(report, aliases);
  report.recoveryCommands = report.recoveryCommands.map((command) =>
    projectCommand(command, aliases),
  );
  projectEvidence(report.initial, aliases);
  projectResult(report, aliases);
  report.warnings.forEach((error) => {
    projectSafeError(error, aliases);
  });
  if (report.error !== undefined) projectSafeError(report.error, aliases);
  if (report.cause !== undefined) projectSafeError(report.cause, aliases);
  return UpdateCommandReportSchema.parse(report);
}

function identitySets(): IdentitySets {
  return {
    command: new Set(),
    diagnostic: new Set(),
    project: new Set(),
    pty: new Set(),
    "pty-instance": new Set(),
    session: new Set(),
    terminal: new Set(),
    trace: new Set(),
    worktree: new Set(),
  };
}

function identityAliases(sets: IdentitySets): IdentityAliases {
  return {
    command: aliasesFor("command", sets.command),
    diagnostic: aliasesFor("diagnostic", sets.diagnostic),
    project: aliasesFor("project", sets.project),
    pty: aliasesFor("pty", sets.pty),
    "pty-instance": aliasesFor("pty-instance", sets["pty-instance"]),
    session: aliasesFor("session", sets.session),
    terminal: aliasesFor("terminal", sets.terminal),
    trace: aliasesFor("trace", sets.trace),
    worktree: aliasesFor("worktree", sets.worktree),
  };
}

function aliasesFor(namespace: IdentityNamespace, values: Set<string>): Map<string, string> {
  const aliases = new Map<string, string>();
  const pattern = new RegExp(`^public-${namespace}-[0-9]{${aliasWidth}}$`, "u");
  const ordered = [...values].sort();
  let next = 1;
  for (const value of ordered) {
    if (pattern.test(value)) {
      aliases.set(value, value);
      const ordinal = Number(value.slice(-aliasWidth));
      next = Math.max(next, ordinal + 1);
    }
  }
  for (const value of ordered) {
    if (aliases.has(value)) continue;
    while (aliases.has(aliasValue(namespace, next))) next += 1;
    aliases.set(value, aliasValue(namespace, next));
    next += 1;
  }
  return aliases;
}

function aliasValue(namespace: IdentityNamespace, ordinal: number): string {
  return `public-${namespace}-${String(ordinal).padStart(aliasWidth, "0")}`;
}

function collectEvidence(evidence: UpdateEvidencePlan, sets: IdentitySets): void {
  collectPreflight(evidence.preflight, sets);
}

function collectPreflight(preflight: UpdateReapRecoveryPreflight, sets: IdentitySets): void {
  preflight.hooks.forEach((hook) => {
    if (hook.status === "inspection-failed") collectSafeError(hook.error, sets);
  });
  if (preflight.observer.status === "unknown") collectSafeError(preflight.observer.error, sets);
  if (preflight.observer.status === "exact") {
    if (preflight.observer.recovery.status === "unknown") {
      collectSafeError(preflight.observer.recovery.error, sets);
    } else {
      const assessment = preflight.observer.recovery.assessment;
      assessment.sessions.forEach((session) => {
        sets.session.add(session.sessionId);
        sets.project.add(session.projectId);
        sets.worktree.add(session.worktreeId);
      });
    }
  }
  if (preflight.host.status === "unknown") collectSafeError(preflight.host.error, sets);
  if (preflight.host.status === "inspected") {
    preflight.host.terminals.forEach((terminal) => {
      collectTerminal(terminal, sets, true);
    });
  }
  preflight.terminalDispositions.forEach((terminal) => {
    collectTerminal(terminal, sets, false);
  });
}

function collectTerminal(
  terminal: {
    terminalTargetId: string;
    ptyId: string;
    ptyInstanceId: string;
    sessionId: string;
    projectId?: string;
    worktreeId?: string;
    harnessProvider?: string;
  },
  sets: IdentitySets,
  extended: boolean,
): void {
  sets.terminal.add(terminal.terminalTargetId);
  sets.pty.add(terminal.ptyId);
  sets["pty-instance"].add(terminal.ptyInstanceId);
  sets.session.add(terminal.sessionId);
  if (extended) {
    if (terminal.projectId !== undefined) sets.project.add(terminal.projectId);
    if (terminal.worktreeId !== undefined) sets.worktree.add(terminal.worktreeId);
  }
}

function collectResult(report: UpdateCommandReport, sets: IdentitySets): void {
  const result = report.result;
  switch (result.kind) {
    case "preview":
      if (result.reapConsequences !== undefined) collectConsequences(result.reapConsequences, sets);
      return;
    case "current-runtime-execution":
      result.actionAudits.forEach((audit) => {
        collectAudit(audit, sets);
      });
      collectEvidence(result.postAction, sets);
      return;
    case "successor-runtime-execution":
      result.actionAudits.forEach((audit) => {
        collectAudit(audit, sets);
      });
      collectEvidence(result.successor, sets);
      collectEvidence(result.postAction, sets);
      return;
    case "execution-failed":
      result.actionAudits.forEach((audit) => {
        collectAudit(audit, sets);
      });
      if (result.successor !== undefined) collectEvidence(result.successor, sets);
      if (result.finalInspection.status === "completed") {
        collectEvidence(result.finalInspection.evidence, sets);
      } else if (result.finalInspection.status === "failed") {
        collectSafeError(result.finalInspection.error, sets);
      }
      return;
    case "already-converged":
    case "deferred":
    case "non-mutating-stop":
      return;
  }
}

function collectAudit(audit: UpdateActionAudit, sets: IdentitySets): void {
  audit.actions.forEach((action) => {
    if (action.hookResult !== undefined) {
      if (
        action.hookResult.status === "write-failed" ||
        action.hookResult.status === "post-write-doctor-failed" ||
        action.hookResult.status === "inspection-failed"
      ) {
        collectSafeError(action.hookResult.error, sets);
      }
    }
    action.handoffReceipt?.terminals.forEach((terminal) => {
      collectTerminal(terminal, sets, false);
    });
  });
}

function collectConsequences(
  consequences: UpdateReapPreviewConsequences,
  sets: IdentitySets,
): void {
  consequences.terminals.forEach((terminal) => {
    collectTerminal(terminal, sets, false);
  });
}

function collectSafeError(error: SafeError, sets: IdentitySets): void {
  if (error.commandId !== undefined) sets.command.add(error.commandId);
  if (error.projectId !== undefined) sets.project.add(error.projectId);
  if (error.worktreeId !== undefined) sets.worktree.add(error.worktreeId);
  if (error.sessionId !== undefined) sets.session.add(error.sessionId);
  if (error.traceId !== undefined) sets.trace.add(error.traceId);
  if (error.diagnosticId !== undefined) sets.diagnostic.add(error.diagnosticId);
}

function projectEvidence(evidence: UpdateEvidencePlan, aliases: IdentityAliases): void {
  projectPreflight(evidence.preflight, aliases);
  if (evidence.plan.installation.managerCommand !== undefined) {
    evidence.plan.installation.managerCommand = projectCommand(
      evidence.plan.installation.managerCommand,
      aliases,
    );
  }
}

function projectPreflight(preflight: UpdateReapRecoveryPreflight, aliases: IdentityAliases): void {
  preflight.hooks.forEach((hook) => {
    if (hook.status === "inspection-failed") projectSafeError(hook.error, aliases);
  });
  if (preflight.observer.status === "unknown") projectSafeError(preflight.observer.error, aliases);
  if (preflight.observer.status === "exact") {
    if (preflight.observer.recovery.status === "unknown") {
      projectSafeError(preflight.observer.recovery.error, aliases);
    } else {
      const assessment = preflight.observer.recovery.assessment;
      assessment.sessions.forEach((session) => {
        session.sessionId = alias(aliases, "session", session.sessionId);
        session.projectId = alias(aliases, "project", session.projectId);
        session.worktreeId = alias(aliases, "worktree", session.worktreeId);
      });
    }
  }
  if (preflight.host.status === "unknown") projectSafeError(preflight.host.error, aliases);
  if (preflight.host.status === "inspected") {
    preflight.host.terminals.forEach((terminal) => {
      projectTerminal(terminal, aliases, true);
    });
  }
  preflight.terminalDispositions.forEach((terminal) => {
    projectTerminal(terminal, aliases, false);
  });
}

function projectTerminal(
  terminal: {
    terminalTargetId: string;
    ptyId: string;
    ptyInstanceId: string;
    sessionId: string;
    projectId?: string;
    worktreeId?: string;
    harnessProvider?: string;
  },
  aliases: IdentityAliases,
  extended: boolean,
): void {
  terminal.terminalTargetId = alias(aliases, "terminal", terminal.terminalTargetId);
  terminal.ptyId = alias(aliases, "pty", terminal.ptyId);
  terminal.ptyInstanceId = alias(aliases, "pty-instance", terminal.ptyInstanceId);
  terminal.sessionId = alias(aliases, "session", terminal.sessionId);
  if (extended) {
    if (terminal.projectId !== undefined) {
      terminal.projectId = alias(aliases, "project", terminal.projectId);
    }
    if (terminal.worktreeId !== undefined) {
      terminal.worktreeId = alias(aliases, "worktree", terminal.worktreeId);
    }
  }
}

function projectResult(report: UpdateCommandReport, aliases: IdentityAliases): void {
  const result = report.result;
  switch (result.kind) {
    case "preview":
      if (result.reapConsequences !== undefined)
        projectConsequences(result.reapConsequences, aliases);
      return;
    case "current-runtime-execution":
      result.actionAudits.forEach((audit) => {
        projectAudit(audit, aliases);
      });
      projectEvidence(result.postAction, aliases);
      return;
    case "successor-runtime-execution":
      result.actionAudits.forEach((audit) => {
        projectAudit(audit, aliases);
      });
      projectEvidence(result.successor, aliases);
      projectEvidence(result.postAction, aliases);
      return;
    case "execution-failed":
      result.actionAudits.forEach((audit) => {
        projectAudit(audit, aliases);
      });
      if (result.successor !== undefined) projectEvidence(result.successor, aliases);
      if (result.finalInspection.status === "completed") {
        projectEvidence(result.finalInspection.evidence, aliases);
      } else if (result.finalInspection.status === "failed") {
        projectSafeError(result.finalInspection.error, aliases);
      }
      return;
    case "already-converged":
    case "deferred":
    case "non-mutating-stop":
      return;
  }
}

function projectAudit(audit: UpdateActionAudit, aliases: IdentityAliases): void {
  audit.actions.forEach((action) => {
    if (action.installation?.managerCommand !== undefined) {
      action.installation.managerCommand = projectCommand(
        action.installation.managerCommand,
        aliases,
      );
    }
    if (action.hookResult !== undefined) {
      if (
        action.hookResult.status === "write-failed" ||
        action.hookResult.status === "post-write-doctor-failed" ||
        action.hookResult.status === "inspection-failed"
      ) {
        projectSafeError(action.hookResult.error, aliases);
      }
    }
    action.handoffReceipt?.terminals.forEach((terminal) => {
      projectTerminal(terminal, aliases, false);
    });
  });
}

function projectArtifactApplicationCommands(
  report: UpdateCommandReport,
  aliases: IdentityAliases,
): void {
  const application = report.artifactApplication;
  if (
    (application.status === "preview" || application.status === "deferred") &&
    application.managerCommand !== undefined
  ) {
    application.managerCommand = projectCommand(application.managerCommand, aliases);
  }
}

function projectCommand(
  command: readonly [string, ...string[]],
  aliases: IdentityAliases,
): [string, ...string[]] {
  const projectedCommand = [...command] as [string, ...string[]];
  projectedCommand.forEach((value, index) => {
    for (const namespace of Object.keys(aliases) as IdentityNamespace[]) {
      const projected = aliases[namespace].get(value);
      if (projected !== undefined) {
        projectedCommand[index] = projected;
        return;
      }
    }
  });
  return projectedCommand;
}

function projectConsequences(
  consequences: UpdateReapPreviewConsequences,
  aliases: IdentityAliases,
): void {
  consequences.terminals.forEach((terminal) => {
    projectTerminal(terminal, aliases, false);
  });
}

function projectSafeError(error: SafeError, aliases: IdentityAliases): void {
  if (error.commandId !== undefined) error.commandId = alias(aliases, "command", error.commandId);
  if (error.projectId !== undefined) error.projectId = alias(aliases, "project", error.projectId);
  if (error.worktreeId !== undefined) {
    error.worktreeId = alias(aliases, "worktree", error.worktreeId);
  }
  if (error.sessionId !== undefined) error.sessionId = alias(aliases, "session", error.sessionId);
  if (error.traceId !== undefined) error.traceId = alias(aliases, "trace", error.traceId);
  if (error.diagnosticId !== undefined) {
    error.diagnosticId = alias(aliases, "diagnostic", error.diagnosticId);
  }
}

function alias(aliases: IdentityAliases, namespace: IdentityNamespace, value: string): string {
  const projected = aliases[namespace].get(value);
  if (projected === undefined) {
    throw new Error(`Missing public ${namespace} identity alias.`);
  }
  return projected;
}
