import type { DiagnosticDetail, SafeError } from "@station/contracts";

export type WorktrunkProviderErrorCode =
  | "WORKTRUNK_BRANCH_EXISTS"
  | "WORKTRUNK_CANCELLED"
  | "WORKTRUNK_COMMAND_FAILED"
  | "WORKTRUNK_HOOK_APPROVAL_REQUIRED"
  | "WORKTRUNK_INVALID_OUTPUT"
  | "WORKTRUNK_BASE_MISSING"
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
