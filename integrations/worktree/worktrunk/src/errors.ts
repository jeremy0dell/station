import type { DiagnosticDetail, SafeError } from "@station/contracts";
import { safeErrorFromUnknown } from "@station/runtime";

export type WorktrunkProviderErrorCode =
  | "WORKTRUNK_BRANCH_EXISTS"
  | "WORKTRUNK_CANCELLED"
  | "WORKTRUNK_COMMAND_FAILED"
  | "WORKTRUNK_HOOK_APPROVAL_REQUIRED"
  | "WORKTRUNK_INVALID_OUTPUT"
  | "WORKTRUNK_BASE_MISSING"
  | "WORKTRUNK_PROJECT_ROOT_BARE"
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
  readonly projectId?: string;
  readonly diagnosticDetails?: DiagnosticDetail[];

  constructor(
    code: WorktrunkProviderErrorCode,
    message: string,
    options: {
      hint?: string;
      projectId?: string;
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
    this.code = code;
    if (options.hint !== undefined) {
      this.hint = options.hint;
    }
    if (options.projectId !== undefined) {
      this.projectId = options.projectId;
    }
    if (options.diagnosticDetails !== undefined) {
      this.diagnosticDetails = options.diagnosticDetails;
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
