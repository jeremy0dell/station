import {
  type DiagnosticDetail,
  DiagnosticDetailSchema,
  type ExternalCommandDiagnosticDetail,
  ExternalCommandDiagnosticDetailSchema,
  type SafeError,
  SafeErrorSchema,
  type WorktreeRemovalRefusalDiagnosticDetail,
} from "@station/contracts";

export type RuntimeDiagnosticDetail = DiagnosticDetail;
export type RuntimeExternalCommandDiagnosticDetail = ExternalCommandDiagnosticDetail;
export type RuntimeWorktreeRemovalRefusalDiagnosticDetail = WorktreeRemovalRefusalDiagnosticDetail;

export type RuntimeSafeError = SafeError & {
  diagnosticDetails?: DiagnosticDetail[];
};

export type RuntimeSafeErrorFallback = {
  tag: string;
  code: string;
  message: string;
  hint?: string | undefined;
  provider?: string | undefined;
  traceId?: string | undefined;
};

export type RuntimeTimeoutError = RuntimeSafeError & {
  tag: "TimeoutError";
};

export type RuntimeCancellationError = RuntimeSafeError & {
  tag: "CancellationError";
};

export type ExternalCommandError = RuntimeSafeError & {
  tag: "ExternalCommandError";
  command: string;
  cwd?: string;
  exitCode?: number;
  signal?: string;
  stdoutSnippet?: string;
  stderrSnippet?: string;
};

type SafeErrorChain = {
  safeError?: SafeError;
  externalCommand?: ExternalCommandFields;
  diagnostics: DiagnosticDetail[];
};

type ExternalCommandFields = Pick<
  ExternalCommandDiagnosticDetail,
  "command" | "cwd" | "exitCode" | "signal" | "stdoutSnippet" | "stderrSnippet"
>;

const RuntimeSafeErrorViewSchema = SafeErrorSchema.strip();
const RuntimeSafeErrorSchema = SafeErrorSchema.extend({
  diagnosticDetails: DiagnosticDetailSchema.array().optional(),
}).strip();
const ExternalCommandFieldsSchema = ExternalCommandDiagnosticDetailSchema.omit({
  type: true,
  provider: true,
  operation: true,
  durationMs: true,
}).strip();

export function isSafeError(value: unknown): value is RuntimeSafeError {
  return RuntimeSafeErrorSchema.safeParse(value).success;
}

export function safeErrorFromUnknown(
  error: unknown,
  fallback: RuntimeSafeErrorFallback,
): RuntimeSafeError {
  const chain = inspectSafeErrorChain(error);
  const safeError = chain.safeError ?? safeErrorFallback(fallback);
  const normalized: RuntimeSafeError = { ...safeError };

  if (chain.diagnostics.length > 0) {
    normalized.diagnosticDetails = chain.diagnostics;
  }
  if (safeError.tag === "ExternalCommandError" && chain.externalCommand !== undefined) {
    copyExternalCommandFields(normalized as ExternalCommandError, chain.externalCommand);
  }

  return normalized;
}

/**
 * Projects an unknown failure onto the lean shared SafeError contract.
 *
 * Runtime-only diagnostic evidence, command fields, raw output, and causes are omitted.
 */
export function publicSafeErrorFromUnknown(
  error: unknown,
  fallback: RuntimeSafeErrorFallback,
): SafeError {
  const normalized = safeErrorFromUnknown(error, fallback);
  return safeErrorView(normalized) ?? safeErrorFallback(fallback);
}

/** Returns whether a normalized runtime failure contains typed external-command fields. */
export function isExternalCommandError(error: RuntimeSafeError): error is ExternalCommandError {
  return error.tag === "ExternalCommandError" && externalCommandFields(error) !== undefined;
}

/** Extracts redacted external-command evidence without exposing process-error shapes. */
export function externalCommandDiagnosticFromSafeError(
  error: RuntimeSafeError,
): ExternalCommandDiagnosticDetail | undefined {
  if (Array.isArray(error.diagnosticDetails)) {
    for (const detail of error.diagnosticDetails) {
      const parsed = ExternalCommandDiagnosticDetailSchema.safeParse(detail);
      if (parsed.success) {
        return parsed.data;
      }
    }
  }

  if (!isExternalCommandError(error)) {
    return undefined;
  }
  const fields = externalCommandFields(error);
  if (fields === undefined) {
    return undefined;
  }
  const detail: ExternalCommandDiagnosticDetail = {
    type: "external_command",
    operation: `externalCommand.${error.command.split(" ")[0] ?? "command"}`,
    ...fields,
  };
  if (error.provider !== undefined) {
    detail.provider = error.provider;
  }
  return ExternalCommandDiagnosticDetailSchema.parse(detail);
}

function inspectSafeErrorChain(error: unknown): SafeErrorChain {
  const seen = new Set<unknown>();
  const diagnostics: DiagnosticDetail[] = [];
  let safeError: SafeError | undefined;
  let externalCommand: ExternalCommandFields | undefined;
  let current: unknown = error;

  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const parsed = safeErrorView(current);
    if (parsed !== undefined) {
      if (safeError === undefined) {
        safeError = parsed;
        if (parsed.tag === "ExternalCommandError") {
          externalCommand = externalCommandFields(current);
        }
      }
      const currentDiagnostics = diagnosticDetails(current);
      diagnostics.push(...currentDiagnostics);
      if (
        parsed.tag === "ExternalCommandError" &&
        !currentDiagnostics.some((detail) => detail.type === "external_command")
      ) {
        const commandDiagnostic = externalCommandDiagnostic(current, parsed);
        if (commandDiagnostic !== undefined) {
          diagnostics.push(commandDiagnostic);
        }
      }
    }
    current = runtimeErrorProperty(current, "cause");
  }

  const result: SafeErrorChain = {
    diagnostics: dedupeDiagnostics(diagnostics),
  };
  if (safeError !== undefined) result.safeError = safeError;
  if (externalCommand !== undefined) result.externalCommand = externalCommand;
  return result;
}

function safeErrorView(value: unknown): SafeError | undefined {
  const parsed = RuntimeSafeErrorViewSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function safeErrorFallback(fallback: RuntimeSafeErrorFallback): SafeError {
  const candidate: Record<string, unknown> = {
    tag: fallback.tag,
    code: fallback.code,
    message: fallback.message,
  };
  if (fallback.hint !== undefined) candidate.hint = fallback.hint;
  if (fallback.provider !== undefined) candidate.provider = fallback.provider;
  if (fallback.traceId !== undefined) candidate.traceId = fallback.traceId;
  return SafeErrorSchema.parse(candidate);
}

function diagnosticDetails(value: object): DiagnosticDetail[] {
  const details = runtimeErrorProperty(value, "diagnosticDetails");
  if (!Array.isArray(details)) {
    return [];
  }
  const parsed: DiagnosticDetail[] = [];
  for (const detail of details) {
    const result = DiagnosticDetailSchema.safeParse(detail);
    if (result.success) {
      parsed.push(result.data);
    }
  }
  return parsed;
}

function externalCommandFields(value: unknown): ExternalCommandFields | undefined {
  const parsed = ExternalCommandFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function externalCommandDiagnostic(
  value: unknown,
  safeError: SafeError,
): ExternalCommandDiagnosticDetail | undefined {
  const fields = externalCommandFields(value);
  if (fields === undefined) {
    return undefined;
  }
  const detail: ExternalCommandDiagnosticDetail = {
    type: "external_command",
    operation: `externalCommand.${fields.command.split(" ")[0] ?? "command"}`,
    ...fields,
  };
  if (safeError.provider !== undefined) detail.provider = safeError.provider;
  const parsed = ExternalCommandDiagnosticDetailSchema.safeParse(detail);
  return parsed.success ? parsed.data : undefined;
}

function copyExternalCommandFields(
  target: ExternalCommandError,
  fields: ExternalCommandFields,
): void {
  target.command = fields.command;
  if (fields.cwd !== undefined) target.cwd = fields.cwd;
  if (fields.exitCode !== undefined) target.exitCode = fields.exitCode;
  if (fields.signal !== undefined) target.signal = fields.signal;
  if (fields.stdoutSnippet !== undefined) target.stdoutSnippet = fields.stdoutSnippet;
  if (fields.stderrSnippet !== undefined) target.stderrSnippet = fields.stderrSnippet;
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

function runtimeErrorProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}
