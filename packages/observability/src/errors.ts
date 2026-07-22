import {
  type DiagnosticDetail,
  DiagnosticDetailSchema,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  type SafeError,
  SafeErrorSchema,
} from "@station/contracts";
import {
  publicSafeErrorFromUnknown,
  type RuntimeSafeError,
  safeErrorFromUnknown,
} from "@station/runtime";
import { redact } from "./redaction.js";

export type SafeErrorFallback = {
  tag: string;
  code: string;
  message: string;
  hint?: string;
  provider?: string;
};

export type ErrorEnvelopeInput = {
  id: string;
  error: unknown;
  fallback: SafeErrorFallback;
  createdAt: string;
  severity?: ErrorEnvelope["severity"];
  commandId?: string;
  traceId?: string;
  spanId?: string;
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  provider?: string;
  raw?: unknown;
};

export function toSafeError(
  error: unknown,
  fallback: SafeErrorFallback,
  context: Partial<
    Pick<
      SafeError,
      "commandId" | "projectId" | "worktreeId" | "sessionId" | "traceId" | "diagnosticId"
    >
  > = {},
): SafeError {
  const projected = publicSafeErrorFromUnknown(error, fallback);
  const safeError: SafeError = {
    tag: projected.tag,
    code: projected.code,
    message: redact(projected.message).value,
  };
  if (projected.hint !== undefined) safeError.hint = redact(projected.hint).value;
  if (projected.commandId !== undefined) safeError.commandId = projected.commandId;
  if (projected.projectId !== undefined) safeError.projectId = projected.projectId;
  if (projected.worktreeId !== undefined) safeError.worktreeId = projected.worktreeId;
  if (projected.sessionId !== undefined) safeError.sessionId = projected.sessionId;
  if (projected.provider !== undefined) safeError.provider = projected.provider;
  if (projected.traceId !== undefined) safeError.traceId = projected.traceId;
  if (projected.diagnosticId !== undefined) safeError.diagnosticId = projected.diagnosticId;
  applySafeErrorContext(safeError, context);
  return SafeErrorSchema.parse(safeError);
}

export function createErrorEnvelope(input: ErrorEnvelopeInput): ErrorEnvelope {
  const context: Partial<
    Pick<
      SafeError,
      "commandId" | "projectId" | "worktreeId" | "sessionId" | "traceId" | "diagnosticId"
    >
  > = {};
  if (input.commandId !== undefined) context.commandId = input.commandId;
  if (input.projectId !== undefined) context.projectId = input.projectId;
  if (input.worktreeId !== undefined) context.worktreeId = input.worktreeId;
  if (input.sessionId !== undefined) context.sessionId = input.sessionId;
  if (input.traceId !== undefined) context.traceId = input.traceId;

  const normalized = safeErrorFromUnknown(input.error, input.fallback);
  const safeError = toSafeError(normalized, input.fallback, context);
  const errorObject = input.error instanceof Error ? input.error : undefined;
  const provider = input.provider ?? safeError.provider;
  const redactedCause = redact(errorObject?.message ?? input.error).value;
  const redactedStack =
    errorObject?.stack === undefined ? undefined : redact(errorObject.stack).value;
  const redactedRaw = input.raw === undefined ? undefined : redact(input.raw).value;
  const redactedDiagnostics = diagnosticsFromRuntimeError(normalized);

  const envelope: ErrorEnvelope = {
    id: input.id,
    tag: safeError.tag,
    code: safeError.code,
    message: typeof redactedCause === "string" ? redactedCause : safeError.message,
    severity: input.severity ?? "error",
    redacted: true,
    createdAt: input.createdAt,
  };
  if (input.commandId !== undefined) envelope.commandId = input.commandId;
  if (input.traceId !== undefined) envelope.traceId = input.traceId;
  if (input.spanId !== undefined) envelope.spanId = input.spanId;
  if (input.projectId !== undefined) envelope.projectId = input.projectId;
  if (input.worktreeId !== undefined) envelope.worktreeId = input.worktreeId;
  if (input.sessionId !== undefined) envelope.sessionId = input.sessionId;
  if (provider !== undefined) envelope.provider = provider;
  if (redactedCause !== undefined) envelope.cause = redactedCause;
  if (redactedStack !== undefined) envelope.stack = redactedStack;
  if (redactedRaw !== undefined) envelope.raw = redactedRaw;
  if (redactedDiagnostics.length > 0) envelope.diagnostics = redactedDiagnostics;

  return ErrorEnvelopeSchema.parse(envelope);
}

function diagnosticsFromRuntimeError(error: RuntimeSafeError): DiagnosticDetail[] {
  const diagnostics: DiagnosticDetail[] = [];
  for (const detail of error.diagnosticDetails ?? []) {
    const redacted = redact(detail).value;
    const parsed = DiagnosticDetailSchema.safeParse(redacted);
    if (parsed.success) {
      diagnostics.push(parsed.data);
    }
  }
  return dedupeDiagnostics(diagnostics);
}

function dedupeDiagnostics(diagnostics: readonly DiagnosticDetail[]): DiagnosticDetail[] {
  const seen = new Set<string>();
  const deduped: DiagnosticDetail[] = [];
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(diagnostic);
  }
  return deduped;
}

function applySafeErrorContext(
  target: SafeError,
  context: Partial<
    Pick<
      SafeError,
      "commandId" | "projectId" | "worktreeId" | "sessionId" | "traceId" | "diagnosticId"
    >
  >,
): void {
  if (context.commandId !== undefined) target.commandId = context.commandId;
  if (context.projectId !== undefined) target.projectId = context.projectId;
  if (context.worktreeId !== undefined) target.worktreeId = context.worktreeId;
  if (context.sessionId !== undefined) target.sessionId = context.sessionId;
  if (context.traceId !== undefined) target.traceId = context.traceId;
  if (context.diagnosticId !== undefined) target.diagnosticId = context.diagnosticId;
}
