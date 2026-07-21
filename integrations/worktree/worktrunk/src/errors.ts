import { type DiagnosticDetail, DiagnosticDetailSchema, type SafeError } from "@station/contracts";
import { safeErrorFromUnknown } from "@station/runtime";

export type WorktrunkProviderErrorCode =
  | "WORKTRUNK_BRANCH_EXISTS"
  | "WORKTRUNK_CANCELLED"
  | "WORKTRUNK_COMMAND_FAILED"
  | "WORKTRUNK_HOOK_APPROVAL_REQUIRED"
  | "WORKTRUNK_INVALID_OUTPUT"
  | "WORKTRUNK_BASE_MISSING"
  | "WORKTRUNK_PROJECT_ROOT_BARE"
  | "WORKTRUNK_PROJECT_ROOT_CHECK_FAILED"
  | "WORKTRUNK_PROJECT_ROOT_REPAIR_FAILED"
  | "WORKTRUNK_SEED_FAILED"
  | "WORKTRUNK_TIMEOUT"
  | "WORKTRUNK_UNAVAILABLE"
  | "WORKTRUNK_UNSUPPORTED_FLAG"
  | "WORKTRUNK_WORKTREE_EXISTS"
  | "WORKTRUNK_WORKTREE_CHANGED"
  | "WORKTRUNK_WORKTREE_NOT_FOUND";

export class WorktrunkProviderError extends Error implements SafeError {
  readonly tag = "WorktreeProviderError";
  readonly provider = "worktrunk";
  readonly code: WorktrunkProviderErrorCode;
  readonly hint?: string;
  readonly diagnosticDetails?: DiagnosticDetail[];

  constructor(
    code: WorktrunkProviderErrorCode,
    message: string,
    options: { hint?: string; cause?: unknown; diagnosticDetails?: DiagnosticDetail[] } = {},
  ) {
    super(message, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
    this.code = code;
    if (options.hint !== undefined) {
      this.hint = options.hint;
    }
    if (options.diagnosticDetails !== undefined) {
      this.diagnosticDetails = options.diagnosticDetails;
    }
  }
}

export class WorktrunkOperationRepairError extends Error implements SafeError {
  readonly tag: string;
  readonly code: string;
  readonly provider: string;
  readonly hint?: string;
  readonly commandId?: string;
  readonly projectId?: string;
  readonly worktreeId?: string;
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly diagnosticId?: string;
  readonly diagnosticDetails?: DiagnosticDetail[];

  constructor(operationError: unknown, repairError: WorktrunkProviderError) {
    const primary = safeErrorFromUnknown(operationError, {
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
      message: "Worktrunk mutation failed.",
      provider: "worktrunk",
    });
    super(primary.message, { cause: operationError });
    Object.defineProperty(this, "name", {
      value: primary.tag,
      enumerable: false,
      configurable: true,
    });
    this.tag = primary.tag;
    this.code = primary.code;
    this.provider = primary.provider ?? "worktrunk";
    const repairHint = `Project-root restoration also failed. ${repairError.hint ?? "Inspect the configured root before retrying."}`;
    this.hint = primary.hint === undefined ? repairHint : `${primary.hint} ${repairHint}`;
    if (primary.commandId !== undefined) this.commandId = primary.commandId;
    if (primary.projectId !== undefined) this.projectId = primary.projectId;
    if (primary.worktreeId !== undefined) this.worktreeId = primary.worktreeId;
    if (primary.sessionId !== undefined) this.sessionId = primary.sessionId;
    if (primary.traceId !== undefined) this.traceId = primary.traceId;
    if (primary.diagnosticId !== undefined) this.diagnosticId = primary.diagnosticId;
    const primaryDiagnostics = (primary.diagnosticDetails ?? []).flatMap((detail) => {
      const parsed = DiagnosticDetailSchema.safeParse(detail);
      return parsed.success ? [parsed.data] : [];
    });
    const diagnosticDetails = [...primaryDiagnostics, ...(repairError.diagnosticDetails ?? [])];
    if (diagnosticDetails.length > 0) {
      this.diagnosticDetails = diagnosticDetails;
    }
  }
}

export class ProviderUnavailableError extends Error implements SafeError {
  readonly tag = "ProviderUnavailableError";
  readonly provider = "worktrunk";
  readonly code = "WORKTRUNK_UNAVAILABLE";
  readonly hint?: string;
  readonly command?: string;
  readonly installHint?: string;
  readonly diagnosticDetails?: DiagnosticDetail[];

  constructor(
    message = "Worktrunk is not available.",
    options: {
      hint?: string;
      command?: string;
      installHint?: string;
      cause?: unknown;
      diagnosticDetails?: DiagnosticDetail[];
    } = {},
  ) {
    super(message, { cause: options.cause });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
    if (options.hint !== undefined) {
      this.hint = options.hint;
    }
    if (options.command !== undefined) {
      this.command = options.command;
    }
    if (options.installHint !== undefined) {
      this.installHint = options.installHint;
    }
    if (options.diagnosticDetails !== undefined) {
      this.diagnosticDetails = options.diagnosticDetails;
    }
  }
}

export function operationErrorWithWorktrunkRepairFailure(
  operationError: unknown,
  repairError: WorktrunkProviderError,
): WorktrunkOperationRepairError {
  return new WorktrunkOperationRepairError(operationError, repairError);
}

export function worktrunkSafeError(
  error: unknown,
  fallback: {
    code: WorktrunkProviderErrorCode;
    message: string;
    hint?: string;
  },
): SafeError {
  return safeErrorFromUnknown(error, {
    tag:
      fallback.code === "WORKTRUNK_UNAVAILABLE"
        ? "ProviderUnavailableError"
        : "WorktreeProviderError",
    code: fallback.code,
    message: fallback.message,
    provider: "worktrunk",
    ...(fallback.hint === undefined ? {} : { hint: fallback.hint }),
  });
}

export function providerErrorFromUnknown(
  error: unknown,
  fallback: {
    code: WorktrunkProviderErrorCode;
    message: string;
    hint?: string;
  },
  options: { diagnosticDetails?: DiagnosticDetail[] } = {},
): WorktrunkProviderError | ProviderUnavailableError {
  const safeError = worktrunkSafeError(error, fallback);
  const hint = safeError.hint ?? fallback.hint;
  const diagnosticDetails = options.diagnosticDetails;
  const message = safeError.code === fallback.code ? safeError.message : fallback.message;
  if (safeError.tag === "ProviderUnavailableError" || fallback.code === "WORKTRUNK_UNAVAILABLE") {
    return new ProviderUnavailableError(message, {
      cause: error,
      ...(hint === undefined ? {} : { hint }),
      ...(diagnosticDetails === undefined ? {} : { diagnosticDetails }),
    });
  }

  return new WorktrunkProviderError(fallback.code, message, {
    cause: error,
    ...(hint === undefined ? {} : { hint }),
    ...(diagnosticDetails === undefined ? {} : { diagnosticDetails }),
  });
}
