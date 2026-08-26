import {
  CliInvocationCallerContextProjectionInputSchema,
  type CliInvocationErrorSummary,
  CliInvocationErrorSummaryProjectionInputSchema,
  CliInvocationErrorSummarySchema,
  type CliInvocationResourceIds,
  CliInvocationResourceIdsProjectionInputSchema,
  CliInvocationResourceIdsSchema,
  CliRunAuditCommandStatusSchema,
  type CliRunAuditMetadata,
  CliRunAuditMetadataProjectionInputSchema,
  CliRunAuditMetadataSchema,
  type LogRecord,
  LogRecordSchema,
  type RedactionReport,
} from "@station/contracts";

export const REDACTION_POLICY_VERSION = "station-redaction-v1";
const REDACTED_VALUE = "[REDACTED]";

export type RedactionResult<T> = {
  value: T;
  report: RedactionReport;
};

type MutableRedactionReport = {
  policyVersion: string;
  generatedAt: string;
  redactedFields: Set<string>;
  redactedPatterns: Set<string>;
  replacements: number;
  suspiciousSecretsFound: number;
};

const SECRET_KEY_PATTERN =
  /(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|auth|credential|private[_-]?key|session[_-]?cookie)/i;

const SECRET_VALUE_PATTERNS: Array<[string, RegExp]> = [
  ["bearer-token", /Bearer\s+[A-Za-z0-9._~+/=-]+/gi],
  ["github-token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}\b/g],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{12,}\b/g],
  ["env-secret", /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*=([^\s]+)/g],
  ["long-secret", /\b[A-Za-z0-9+/=]{40,}\b/g],
];

export function redact<T>(input: T, now = new Date()): RedactionResult<T> {
  const mutable: MutableRedactionReport = {
    policyVersion: REDACTION_POLICY_VERSION,
    generatedAt: now.toISOString(),
    redactedFields: new Set<string>(),
    redactedPatterns: new Set<string>(),
    replacements: 0,
    suspiciousSecretsFound: 0,
  };

  return {
    value: redactValue(input, mutable, []) as T,
    report: finalizeReport(mutable),
  };
}

export function allowlistedCliRunAuditMetadata(input: unknown): CliRunAuditMetadata | undefined {
  const parsed = CliRunAuditMetadataSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const projected = CliRunAuditMetadataProjectionInputSchema.safeParse(input);
  if (!projected.success) return undefined;
  const candidate = projected.data;
  const metadata: CliRunAuditMetadata = {};

  const commandStatus = CliRunAuditCommandStatusSchema.safeParse(candidate.commandStatus);
  if (commandStatus.success) metadata.commandStatus = commandStatus.data;
  const command = CliRunAuditMetadataSchema.safeParse({ command: candidate.command });
  if (command.success && command.data.command !== undefined)
    metadata.command = command.data.command;
  const collection = CliRunAuditMetadataSchema.safeParse({ collection: candidate.collection });
  if (collection.success && collection.data.collection !== undefined) {
    metadata.collection = collection.data.collection;
  }
  const placement = CliRunAuditMetadataSchema.safeParse({ placement: candidate.placement });
  if (placement.success && placement.data.placement !== undefined) {
    metadata.placement = placement.data.placement;
  }
  const callerContext = allowlistedCallerContext(candidate.callerContext);
  if (callerContext !== undefined) metadata.callerContext = callerContext;
  const resources = allowlistedResourceIds(candidate.resources);
  if (resources !== undefined) metadata.resources = resources;
  const error = allowlistedErrorSummary(candidate.error);
  if (error !== undefined) metadata.error = error;

  const sanitized = CliRunAuditMetadataSchema.safeParse(metadata);
  return sanitized.success && Object.keys(sanitized.data).length > 0 ? sanitized.data : undefined;
}

export function redactCliInvocationRecord(input: unknown): LogRecord {
  const parsed = LogRecordSchema.parse(input);
  if (parsed.component !== "cli" || parsed.cliInvocation === undefined) {
    throw new Error("CLI invocation redaction requires a strict CLI lifecycle log record.");
  }
  // The strict invocation contract is itself the allowlist. Generic value-pattern replacement
  // would corrupt exact build and resource identities, so suspicious identifiers are dropped by
  // `allowlistedCliRunAuditMetadata` before this final validation.
  return parsed;
}

export function mergeRedactionReports(
  reports: readonly RedactionReport[],
  generatedAt = new Date().toISOString(),
): RedactionReport {
  const fields = new Set<string>();
  const patterns = new Set<string>();
  let replacements = 0;
  let suspiciousSecretsFound = 0;

  for (const report of reports) {
    for (const field of report.redactedFields) {
      fields.add(field);
    }
    for (const pattern of report.redactedPatterns) {
      patterns.add(pattern);
    }
    replacements += report.replacements;
    suspiciousSecretsFound += report.suspiciousSecretsFound;
  }

  return {
    policyVersion: REDACTION_POLICY_VERSION,
    generatedAt,
    redactedFields: [...fields].sort(),
    redactedPatterns: [...patterns].sort(),
    replacements,
    suspiciousSecretsFound,
  };
}

export function redactString(value: string, report?: RedactionReport): string {
  const mutable: MutableRedactionReport = reportToMutable(report);
  return redactStringInternal(value, mutable);
}

function redactValue(
  value: unknown,
  report: MutableRedactionReport,
  path: readonly string[],
): unknown {
  if (typeof value === "string") {
    return redactStringInternal(value, report);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, report, [...path, String(index)]));
  }

  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    // Key-based matches redact the whole field; value patterns preserve surrounding text.
    if (SECRET_KEY_PATTERN.test(key)) {
      report.redactedFields.add(childPath.join("."));
      report.replacements += 1;
      report.suspiciousSecretsFound += 1;
      result[key] = REDACTED_VALUE;
      continue;
    }

    result[key] = redactValue(child, report, childPath);
  }
  return result;
}

function redactStringInternal(value: string, report: MutableRedactionReport): string {
  let redacted = value;
  for (const [name, pattern] of SECRET_VALUE_PATTERNS) {
    // Each regex has global state; replace() advances it while recording every match.
    redacted = redacted.replace(pattern, (match) => {
      report.redactedPatterns.add(name);
      report.replacements += 1;
      report.suspiciousSecretsFound += 1;
      if (name === "env-secret") {
        const key = match.split("=")[0];
        return `${key}=${REDACTED_VALUE}`;
      }
      if (name === "bearer-token") {
        return `Bearer ${REDACTED_VALUE}`;
      }
      return REDACTED_VALUE;
    });
  }
  return redacted;
}

function finalizeReport(report: MutableRedactionReport): RedactionReport {
  return {
    policyVersion: report.policyVersion,
    generatedAt: report.generatedAt,
    redactedFields: [...report.redactedFields].sort(),
    redactedPatterns: [...report.redactedPatterns].sort(),
    replacements: report.replacements,
    suspiciousSecretsFound: report.suspiciousSecretsFound,
  };
}

function reportToMutable(report: RedactionReport | undefined): MutableRedactionReport {
  return {
    policyVersion: REDACTION_POLICY_VERSION,
    generatedAt: report?.generatedAt ?? new Date().toISOString(),
    redactedFields: new Set(report?.redactedFields ?? []),
    redactedPatterns: new Set(report?.redactedPatterns ?? []),
    replacements: report?.replacements ?? 0,
    suspiciousSecretsFound: report?.suspiciousSecretsFound ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function allowlistedCallerContext(input: unknown): CliRunAuditMetadata["callerContext"] {
  const candidate = CliRunAuditMetadataSchema.safeParse({ callerContext: input });
  if (candidate.success) return candidate.data.callerContext;
  const projected = CliInvocationCallerContextProjectionInputSchema.safeParse(input);
  if (!projected.success) return undefined;
  const parsed = CliRunAuditMetadataSchema.safeParse({
    callerContext: { presentation: projected.data.presentation },
  });
  if (parsed.success) {
    return parsed.data.callerContext;
  }
  return undefined;
}

function allowlistedResourceIds(input: unknown): CliInvocationResourceIds | undefined {
  const projected = CliInvocationResourceIdsProjectionInputSchema.safeParse(input);
  if (!projected.success) return undefined;
  const candidate = projected.data;
  const resources: Partial<CliInvocationResourceIds> = {};

  const project = CliInvocationResourceIdsSchema.safeParse({ projectId: candidate.projectId });
  if (project.success && project.data.projectId !== undefined) {
    resources.projectId = project.data.projectId;
  }
  const worktree = CliInvocationResourceIdsSchema.safeParse({
    worktreeId: candidate.worktreeId,
  });
  if (worktree.success && worktree.data.worktreeId !== undefined) {
    resources.worktreeId = worktree.data.worktreeId;
  }
  const session = CliInvocationResourceIdsSchema.safeParse({ sessionId: candidate.sessionId });
  if (session.success && session.data.sessionId !== undefined) {
    resources.sessionId = session.data.sessionId;
  }
  const group = CliInvocationResourceIdsSchema.safeParse({ groupId: candidate.groupId });
  if (group.success && group.data.groupId !== undefined) resources.groupId = group.data.groupId;
  const target = CliInvocationResourceIdsSchema.safeParse({ targetId: candidate.targetId });
  if (target.success && target.data.targetId !== undefined)
    resources.targetId = target.data.targetId;
  const run = CliInvocationResourceIdsSchema.safeParse({ runId: candidate.runId });
  if (run.success && run.data.runId !== undefined) resources.runId = run.data.runId;
  const provider = CliInvocationResourceIdsSchema.safeParse({ provider: candidate.provider });
  if (provider.success && provider.data.provider !== undefined) {
    resources.provider = provider.data.provider;
  }
  const parsed = CliInvocationResourceIdsSchema.safeParse(resources);
  return parsed.success ? parsed.data : undefined;
}

function allowlistedErrorSummary(input: unknown): CliInvocationErrorSummary | undefined {
  const projected = CliInvocationErrorSummaryProjectionInputSchema.safeParse(input);
  if (!projected.success) return undefined;
  const candidate = projected.data;
  const base = CliInvocationErrorSummarySchema.safeParse({
    tag: candidate.tag,
    code: candidate.code,
  });
  if (!base.success) return undefined;
  const error: CliInvocationErrorSummary = base.data;

  const command = CliInvocationErrorSummarySchema.safeParse({
    ...error,
    commandId: candidate.commandId,
  });
  if (command.success && command.data.commandId !== undefined) {
    error.commandId = command.data.commandId;
  }
  const trace = CliInvocationErrorSummarySchema.safeParse({ ...error, traceId: candidate.traceId });
  if (trace.success && trace.data.traceId !== undefined) error.traceId = trace.data.traceId;
  const diagnostic = CliInvocationErrorSummarySchema.safeParse({
    ...error,
    diagnosticId: candidate.diagnosticId,
  });
  if (diagnostic.success && diagnostic.data.diagnosticId !== undefined) {
    error.diagnosticId = diagnostic.data.diagnosticId;
  }
  const project = CliInvocationErrorSummarySchema.safeParse({
    ...error,
    projectId: candidate.projectId,
  });
  if (project.success && project.data.projectId !== undefined) {
    error.projectId = project.data.projectId;
  }
  const worktree = CliInvocationErrorSummarySchema.safeParse({
    ...error,
    worktreeId: candidate.worktreeId,
  });
  if (worktree.success && worktree.data.worktreeId !== undefined) {
    error.worktreeId = worktree.data.worktreeId;
  }
  const session = CliInvocationErrorSummarySchema.safeParse({
    ...error,
    sessionId: candidate.sessionId,
  });
  if (session.success && session.data.sessionId !== undefined) {
    error.sessionId = session.data.sessionId;
  }
  const provider = CliInvocationErrorSummarySchema.safeParse({
    ...error,
    provider: candidate.provider,
  });
  if (provider.success && provider.data.provider !== undefined) {
    error.provider = provider.data.provider;
  }
  return error;
}
