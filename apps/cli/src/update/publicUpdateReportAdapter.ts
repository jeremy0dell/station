import {
  type ObserverLifecycleFailure,
  ObserverLifecycleFailureSchema,
  type ObserverStartupEvidence,
  type ProviderHookHealth,
  type ProviderHookReconciliationResult,
  ProviderHookReconciliationResultSchema,
  type SafeError,
  SafeErrorSchema,
  type UpdateActionAudit,
  type UpdateCommandReport,
  UpdateCommandReportSchema,
  type UpdateConvergenceResult,
  type UpdateEvidencePlan,
  type UpdateFinalInspection,
  type UpdateReapHostEvidence,
  type UpdateReapObserverEvidence,
  type UpdateReapRecoveryPreflight,
  updateCommandReportStatus,
} from "@station/contracts";
import { redact, redactString } from "@station/observability";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import type { PublicUpdateReportInput } from "./updatePublicReportPort.js";

const publicPathReplacement = "[REDACTED_PATH]";
const publicControlReplacement = "[REDACTED_CONTROL]";
const privateFileUrlPattern = /\bfile:\/\/\/[^\s"'<>|]+/gu;
const absolutePosixPathPattern = /(?<![A-Za-z0-9_/])\/(?!\/)[^\s"'<>|]+/gu;
const absoluteWindowsPathPattern = /(?<![A-Za-z0-9_])[A-Za-z]:\\[^\s"'<>|]+/gu;
const homeRelativePathPattern = /(?<![A-Za-z0-9_])~[\\/][^\s"'<>|]+/gu;

/**
 * ADAPTER
 *
 * Projects one internal convergence outcome into the strict, redaction-safe public v4 report.
 */
export function createPublicUpdateReport(input: PublicUpdateReportInput): UpdateCommandReport {
  const core = {
    schemaVersion: 4 as const,
    channel: input.selected.channel,
    current: input.current,
    target: input.target,
    artifactApplication: input.artifactApplication,
    initial: input.initial,
    result: input.result,
    warnings: (input.warnings ?? []).map((warning) =>
      publicSafeErrorFromUnknown(warning, {
        tag: warning.tag,
        code: warning.code,
        message: warning.message,
      }),
    ),
    recoveryCommands: input.recoveryCommands ?? [],
  };
  const report: UpdateCommandReport = { ...core, status: updateCommandReportStatus(core) };
  if (input.error !== undefined) {
    report.error = publicSafeErrorFromUnknown(input.error, {
      tag: input.error.tag,
      code: input.error.code,
      message: input.error.message,
    });
  }
  if (input.cause !== undefined) {
    const cause = publicSafeErrorFromUnknown(input.cause, {
      tag: input.cause.tag,
      code: input.cause.code,
      message: input.cause.message,
    });
    report.cause = redact(cause).value;
  }
  if (input.startupEvidence !== undefined) {
    report.startupEvidence = redact(input.startupEvidence).value;
  }
  return sanitizePublicUpdateReport(report);
}

/**
 * ADAPTER
 *
 * Defines the deterministic confidentiality decision for one strict v4 update result. Every nested
 * SafeError crosses this policy, including successor and post-action evidence, without weakening
 * report invariants or optional-field absence.
 */
export function sanitizePublicUpdateReport(input: UpdateCommandReport): UpdateCommandReport {
  const report = UpdateCommandReportSchema.parse(input);
  const sanitized: UpdateCommandReport = {
    schemaVersion: 4,
    channel: report.channel,
    status: report.status,
    current: report.current,
    target: report.target,
    artifactApplication: report.artifactApplication,
    initial: sanitizeEvidence(report.initial),
    result: sanitizeResult(report.result),
    warnings: report.warnings.map(sanitizePublicSafeError),
    recoveryCommands: report.recoveryCommands,
  };
  if (report.error !== undefined) sanitized.error = sanitizePublicSafeError(report.error);
  if (report.cause !== undefined) sanitized.cause = sanitizePublicSafeError(report.cause);
  if (report.startupEvidence !== undefined) {
    sanitized.startupEvidence = sanitizeStartupEvidence(report.startupEvidence);
  }
  return UpdateCommandReportSchema.parse(sanitized);
}

/** Sanitizes an already-shaped SafeError while preserving its useful typed identity fields. */
export function sanitizePublicSafeError(input: SafeError): SafeError {
  const error = SafeErrorSchema.parse(input);
  const sanitized: SafeError = {
    tag: error.tag,
    code: error.code,
    message: sanitizePublicErrorText(error.message),
  };
  if (error.hint !== undefined) sanitized.hint = sanitizePublicErrorText(error.hint);
  if (error.commandId !== undefined) sanitized.commandId = error.commandId;
  if (error.projectId !== undefined) sanitized.projectId = error.projectId;
  if (error.worktreeId !== undefined) sanitized.worktreeId = error.worktreeId;
  if (error.sessionId !== undefined) sanitized.sessionId = error.sessionId;
  if (error.provider !== undefined) sanitized.provider = error.provider;
  if (error.traceId !== undefined) sanitized.traceId = error.traceId;
  if (error.diagnosticId !== undefined) sanitized.diagnosticId = error.diagnosticId;
  return SafeErrorSchema.parse(sanitized);
}

/** Sanitizes the strict hook child result before it can enter an action audit. */
export function sanitizePublicHookResult(
  input: ProviderHookReconciliationResult,
): ProviderHookReconciliationResult {
  const result = ProviderHookReconciliationResultSchema.parse(input);
  switch (result.status) {
    case "write-failed":
    case "post-write-doctor-failed":
    case "inspection-failed":
      return ProviderHookReconciliationResultSchema.parse({
        ...result,
        error: sanitizePublicSafeError(result.error),
      });
    case "configured-disabled":
    case "unsupported":
    case "healthy":
    case "repaired":
    case "ownership-conflict":
      return result;
  }
}

/** Sanitizes strict Observer child lifecycle evidence before parent report propagation. */
export function sanitizePublicObserverLifecycleFailure(
  input: ObserverLifecycleFailure,
): ObserverLifecycleFailure {
  const failure = ObserverLifecycleFailureSchema.parse(input);
  const sanitized: ObserverLifecycleFailure = {
    error: sanitizePublicSafeError(failure.error),
  };
  if (failure.cause !== undefined) sanitized.cause = sanitizePublicSafeError(failure.cause);
  if (failure.startupEvidence !== undefined) {
    sanitized.startupEvidence = sanitizeStartupEvidence(failure.startupEvidence);
  }
  return ObserverLifecycleFailureSchema.parse(sanitized);
}

function sanitizeEvidence(evidence: UpdateEvidencePlan): UpdateEvidencePlan {
  return {
    evaluator: evidence.evaluator,
    preflight: sanitizePreflight(evidence.preflight),
    plan: evidence.plan,
  };
}

function sanitizePreflight(preflight: UpdateReapRecoveryPreflight): UpdateReapRecoveryPreflight {
  return {
    ...preflight,
    observer: sanitizeObserver(preflight.observer),
    host: sanitizeHost(preflight.host),
    hooks: preflight.hooks.map(sanitizeHookHealth),
  };
}

function sanitizeObserver(observer: UpdateReapObserverEvidence): UpdateReapObserverEvidence {
  switch (observer.status) {
    case "absent":
      return observer;
    case "unknown":
      return { ...observer, error: sanitizePublicSafeError(observer.error) };
    case "exact":
      return observer.recovery.status === "unknown"
        ? {
            ...observer,
            recovery: {
              ...observer.recovery,
              error: sanitizePublicSafeError(observer.recovery.error),
            },
          }
        : observer;
  }
}

function sanitizeHost(host: UpdateReapHostEvidence): UpdateReapHostEvidence {
  return host.status === "unknown" ? { ...host, error: sanitizePublicSafeError(host.error) } : host;
}

function sanitizeHookHealth(hook: ProviderHookHealth): ProviderHookHealth {
  return hook.status === "inspection-failed"
    ? { ...hook, error: sanitizePublicSafeError(hook.error) }
    : hook;
}

function sanitizeResult(result: UpdateConvergenceResult): UpdateConvergenceResult {
  switch (result.kind) {
    case "already-converged":
    case "preview":
    case "deferred":
    case "non-mutating-stop":
      return result;
    case "current-runtime-execution":
      return {
        ...result,
        actionAudits: [sanitizeAudit(result.actionAudits[0])],
        postAction: sanitizeEvidence(result.postAction),
      };
    case "successor-runtime-execution":
      return {
        ...result,
        actionAudits: result.actionAudits.map(sanitizeAudit),
        successor: sanitizeEvidence(result.successor),
        postAction: sanitizeEvidence(result.postAction),
      };
    case "execution-failed": {
      const sanitized: Extract<UpdateConvergenceResult, { kind: "execution-failed" }> = {
        kind: "execution-failed",
        stage: result.stage,
        actionAudits: result.actionAudits.map(sanitizeAudit),
        finalInspection: sanitizeFinalInspection(result.finalInspection),
      };
      if (result.successor !== undefined) sanitized.successor = sanitizeEvidence(result.successor);
      return sanitized;
    }
  }
}

function sanitizeAudit(audit: UpdateActionAudit): UpdateActionAudit {
  return {
    ...audit,
    actions: audit.actions.map((action) =>
      action.hookResult === undefined
        ? action
        : { ...action, hookResult: sanitizePublicHookResult(action.hookResult) },
    ),
  };
}

function sanitizeFinalInspection(inspection: UpdateFinalInspection): UpdateFinalInspection {
  switch (inspection.status) {
    case "completed":
      return { status: "completed", evidence: sanitizeEvidence(inspection.evidence) };
    case "failed":
      return { status: "failed", error: sanitizePublicSafeError(inspection.error) };
    case "not-attempted":
      return inspection;
  }
}

function sanitizeStartupEvidence(evidence: ObserverStartupEvidence): ObserverStartupEvidence {
  const sanitized: ObserverStartupEvidence = {
    bootLogPath: redactString(evidence.bootLogPath),
  };
  if (evidence.bootLogTail !== undefined) {
    sanitized.bootLogTail = sanitizePublicErrorText(evidence.bootLogTail);
  }
  return sanitized;
}

function sanitizePublicErrorText(value: string): string {
  const redacted = redactString(value)
    .replace(privateFileUrlPattern, publicPathReplacement)
    .replace(absoluteWindowsPathPattern, publicPathReplacement)
    .replace(homeRelativePathPattern, publicPathReplacement)
    .replace(absolutePosixPathPattern, publicPathReplacement);
  let sanitized = "";
  let replacingControl = false;
  for (const character of redacted) {
    const point = character.codePointAt(0) ?? 0;
    const unsafe =
      point <= 31 || (point >= 127 && point <= 159) || point === 8232 || point === 8233;
    if (unsafe) {
      if (!replacingControl) sanitized += publicControlReplacement;
      replacingControl = true;
      continue;
    }
    replacingControl = false;
    sanitized += character;
  }
  return sanitized;
}
