import {
  type DiagnosticDetail,
  DiagnosticDetailSchema,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  type SafeError,
  SafeErrorSchema,
} from "@station/contracts";
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
  const knownSafeError = isSafeErrorLike(error) ? error : safeErrorCause(error);
  const known = knownSafeError ?? fallback;
  const safeMessage = redact(known.message).value;
  const safeError: SafeError = {
    tag: known.tag,
    code: known.code,
    message: safeMessage,
  };
  if (known.hint !== undefined) safeError.hint = redact(known.hint).value;
  if (known.provider !== undefined) safeError.provider = known.provider;
  if (knownSafeError?.projectId !== undefined) safeError.projectId = knownSafeError.projectId;
  if (knownSafeError?.worktreeId !== undefined) safeError.worktreeId = knownSafeError.worktreeId;
  if (knownSafeError?.sessionId !== undefined) safeError.sessionId = knownSafeError.sessionId;
  if (knownSafeError?.diagnosticId !== undefined) {
    safeError.diagnosticId = knownSafeError.diagnosticId;
  }
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

  const safeError = toSafeError(input.error, input.fallback, context);
  const errorObject = input.error instanceof Error ? input.error : undefined;
  const provider = input.provider ?? safeError.provider;
  const redactedCause = redact(errorObject?.message ?? input.error).value;
  const redactedStack =
    errorObject?.stack === undefined ? undefined : redact(errorObject.stack).value;
  const redactedRaw = input.raw === undefined ? undefined : redact(input.raw).value;
  const redactedDiagnostics = diagnosticsFromUnknown(input.error);

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

function isSafeErrorLike(value: unknown): value is SafeError {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SafeError>;
  return (
    typeof candidate.tag === "string" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string"
  );
}

function safeErrorCause(error: unknown, seen = new Set<unknown>()): SafeError | undefined {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  const cause = (error as { cause?: unknown }).cause;
  if (isSafeErrorLike(cause)) {
    return cause;
  }
  return safeErrorCause(cause, seen);
}

function diagnosticsFromUnknown(error: unknown, seen = new Set<unknown>()): DiagnosticDetail[] {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return [];
  }
  seen.add(error);
  const diagnostics: DiagnosticDetail[] = [];
  const record = error as {
    diagnosticDetails?: unknown;
    cause?: unknown;
  };

  if (Array.isArray(record.diagnosticDetails)) {
    for (const detail of record.diagnosticDetails) {
      const redacted = redact(detail).value;
      const parsed = DiagnosticDetailSchema.safeParse(redacted);
      if (parsed.success) {
        diagnostics.push(parsed.data);
      }
    }
  }

  const externalDetail = externalCommandDiagnosticFromUnknown(error);
  if (externalDetail !== undefined) {
    diagnostics.push(externalDetail);
  }

  diagnostics.push(...diagnosticsFromUnknown(record.cause, seen));
  return dedupeDiagnostics(diagnostics);
}

function externalCommandDiagnosticFromUnknown(error: unknown): DiagnosticDetail | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (record.tag !== "ExternalCommandError" || typeof record.command !== "string") {
    return undefined;
  }

  const detail: DiagnosticDetail = {
    type: "external_command",
    operation: `externalCommand.${record.command.split(" ")[0] ?? "command"}`,
    command: record.command,
  };
  if (typeof record.provider === "string") detail.provider = record.provider;
  if (typeof record.cwd === "string") detail.cwd = record.cwd;
  if (typeof record.exitCode === "number") detail.exitCode = record.exitCode;
  if (typeof record.signal === "string") detail.signal = record.signal;
  if (typeof record.stdoutSnippet === "string" && record.stdoutSnippet.length > 0) {
    detail.stdoutSnippet = record.stdoutSnippet;
  }
  if (typeof record.stderrSnippet === "string" && record.stderrSnippet.length > 0) {
    detail.stderrSnippet = record.stderrSnippet;
  }
  const parsed = DiagnosticDetailSchema.safeParse(redact(detail).value);
  return parsed.success ? parsed.data : undefined;
}

function dedupeDiagnostics(diagnostics: readonly DiagnosticDetail[]): DiagnosticDetail[] {
  const seen = new Set<string>();
  const deduped: DiagnosticDetail[] = [];
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) {
      continue;
    }
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
