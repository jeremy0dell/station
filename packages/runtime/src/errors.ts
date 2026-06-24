export type RuntimeSafeError = {
  tag: string;
  code: string;
  message: string;
  hint?: string;
  commandId?: string;
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  provider?: string;
  traceId?: string;
  diagnosticId?: string;
  diagnosticDetails?: RuntimeDiagnosticDetail[];
};

export type RuntimeExternalCommandDiagnosticDetail = {
  type: "external_command";
  provider?: string;
  operation: string;
  command: string;
  cwd?: string;
  exitCode?: number;
  signal?: string;
  stdoutSnippet?: string;
  stderrSnippet?: string;
  durationMs?: number;
};

export type RuntimeDiagnosticDetail = RuntimeExternalCommandDiagnosticDetail;

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

export function isSafeError(value: unknown): value is RuntimeSafeError {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RuntimeSafeError>;
  return (
    typeof candidate.tag === "string" &&
    candidate.tag.length > 0 &&
    typeof candidate.code === "string" &&
    candidate.code.length > 0 &&
    typeof candidate.message === "string" &&
    candidate.message.length > 0
  );
}

export function safeErrorFromUnknown(
  error: unknown,
  fallback: RuntimeSafeErrorFallback,
): RuntimeSafeError {
  if (isSafeError(error)) {
    return copySafeError(error);
  }
  const cause = safeErrorCause(error);
  if (cause !== undefined) {
    return copySafeError(cause);
  }

  const safeError: RuntimeSafeError = {
    tag: fallback.tag,
    code: fallback.code,
    message: fallback.message,
  };

  if (fallback.hint !== undefined) {
    safeError.hint = fallback.hint;
  }
  if (fallback.provider !== undefined) {
    safeError.provider = fallback.provider;
  }
  if (fallback.traceId !== undefined) {
    safeError.traceId = fallback.traceId;
  }

  return safeError;
}

function copySafeError(input: RuntimeSafeError): RuntimeSafeError {
  const safeError: RuntimeSafeError = {
    tag: input.tag,
    code: input.code,
    message: input.message,
  };
  if (input.hint !== undefined) safeError.hint = input.hint;
  if (input.commandId !== undefined) safeError.commandId = input.commandId;
  if (input.projectId !== undefined) safeError.projectId = input.projectId;
  if (input.worktreeId !== undefined) safeError.worktreeId = input.worktreeId;
  if (input.sessionId !== undefined) safeError.sessionId = input.sessionId;
  if (input.provider !== undefined) safeError.provider = input.provider;
  if (input.traceId !== undefined) safeError.traceId = input.traceId;
  if (input.diagnosticId !== undefined) safeError.diagnosticId = input.diagnosticId;
  if (input.diagnosticDetails !== undefined) {
    safeError.diagnosticDetails = input.diagnosticDetails.map(copyDiagnosticDetail);
  }
  if (input.tag === "ExternalCommandError") {
    const source = input as Partial<ExternalCommandError>;
    const target = safeError as ExternalCommandError;
    if (typeof source.command === "string") target.command = source.command;
    if (typeof source.cwd === "string") target.cwd = source.cwd;
    if (typeof source.exitCode === "number") target.exitCode = source.exitCode;
    if (typeof source.signal === "string") target.signal = source.signal;
    if (typeof source.stdoutSnippet === "string") target.stdoutSnippet = source.stdoutSnippet;
    if (typeof source.stderrSnippet === "string") target.stderrSnippet = source.stderrSnippet;
  }
  return safeError;
}

function safeErrorCause(error: unknown, seen = new Set<unknown>()): RuntimeSafeError | undefined {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  const cause = (error as { cause?: unknown }).cause;
  if (isSafeError(cause)) {
    return cause;
  }
  return safeErrorCause(cause, seen);
}

function copyDiagnosticDetail(detail: RuntimeDiagnosticDetail): RuntimeDiagnosticDetail {
  const copied: RuntimeExternalCommandDiagnosticDetail = {
    type: "external_command",
    operation: detail.operation,
    command: detail.command,
  };
  if (detail.provider !== undefined) copied.provider = detail.provider;
  if (detail.cwd !== undefined) copied.cwd = detail.cwd;
  if (detail.exitCode !== undefined) copied.exitCode = detail.exitCode;
  if (detail.signal !== undefined) copied.signal = detail.signal;
  if (detail.stdoutSnippet !== undefined) copied.stdoutSnippet = detail.stdoutSnippet;
  if (detail.stderrSnippet !== undefined) copied.stderrSnippet = detail.stderrSnippet;
  if (detail.durationMs !== undefined) copied.durationMs = detail.durationMs;
  return copied;
}
