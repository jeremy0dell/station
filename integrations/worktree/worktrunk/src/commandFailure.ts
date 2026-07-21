import { stripVTControlCharacters } from "node:util";
import type {
  DiagnosticDetail,
  ExternalCommandDiagnosticDetail,
  ProviderId,
} from "@station/contracts";
import {
  externalCommandDiagnosticFromSafeError,
  externalCommandErrorFromUnknown,
  type RuntimeSafeError,
} from "@station/runtime";
import type { WorktrunkProviderErrorCode } from "./errors.js";
import { ProviderUnavailableError, WorktrunkProviderError } from "./errors.js";

export type WorktrunkCommandFailureFallback = {
  code: "WORKTRUNK_COMMAND_FAILED" | "WORKTRUNK_UNAVAILABLE";
  message: string;
  unresolvedBase?: string;
};

export type WorktrunkCommandFailureInput = {
  error: RuntimeSafeError;
  provider: ProviderId;
  operation: string;
  command: string;
  args: readonly string[];
  cwd?: string | undefined;
  durationMs: number;
  fallback: WorktrunkCommandFailureFallback;
  installHint: string;
};

export function worktrunkCommandFailure(
  input: WorktrunkCommandFailureInput,
): WorktrunkProviderError | ProviderUnavailableError {
  const commandDiagnostic = enrichedCommandDiagnostic(input);
  const diagnosticDetails = retainedDiagnostics(input.error, commandDiagnostic);

  if (input.error.code === "ENOENT") {
    return new ProviderUnavailableError("Worktrunk is not available.", {
      hint: input.installHint,
      command: input.command,
      installHint: input.installHint,
      cause: input.error,
      diagnosticDetails,
    });
  }
  if (input.error.code === "WORKTRUNK_TIMEOUT" || input.error.code === "EXTERNAL_COMMAND_TIMEOUT") {
    return new WorktrunkProviderError("WORKTRUNK_TIMEOUT", "Worktrunk command timed out.", {
      cause: input.error,
      diagnosticDetails,
    });
  }
  if (
    input.error.code === "WORKTRUNK_CANCELLED" ||
    input.error.code === "EXTERNAL_COMMAND_ABORTED" ||
    input.error.tag === "CancellationError"
  ) {
    return new WorktrunkProviderError("WORKTRUNK_CANCELLED", "Worktrunk command was cancelled.", {
      cause: input.error,
      diagnosticDetails,
    });
  }

  const classified = classifyWorktrunkFailure(input.error, input.fallback);
  const hint = input.error.hint ?? classified.hint;
  const message = input.error.code === classified.code ? input.error.message : classified.message;
  if (classified.code === "WORKTRUNK_UNAVAILABLE") {
    return new ProviderUnavailableError(message, {
      cause: input.error,
      diagnosticDetails,
      ...(hint === undefined ? {} : { hint }),
    });
  }
  return new WorktrunkProviderError(classified.code, message, {
    cause: input.error,
    diagnosticDetails,
    ...(hint === undefined ? {} : { hint }),
  });
}

function enrichedCommandDiagnostic(
  input: WorktrunkCommandFailureInput,
): ExternalCommandDiagnosticDetail {
  const evidence =
    externalCommandDiagnosticFromSafeError(input.error) ??
    externalCommandDiagnosticFromSafeError(
      externalCommandErrorFromUnknown(input.error, {
        command: input.command,
        args: [...input.args],
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      }),
    );
  const detail: ExternalCommandDiagnosticDetail = {
    type: "external_command",
    provider: input.provider,
    operation: input.operation,
    command: evidence?.command ?? input.command,
    durationMs: input.durationMs,
  };
  const cwd = evidence?.cwd ?? input.cwd;
  if (cwd !== undefined) detail.cwd = cwd;
  if (evidence?.exitCode !== undefined) detail.exitCode = evidence.exitCode;
  if (evidence?.signal !== undefined) detail.signal = evidence.signal;
  if (evidence?.stdoutSnippet !== undefined) detail.stdoutSnippet = evidence.stdoutSnippet;
  if (evidence?.stderrSnippet !== undefined) detail.stderrSnippet = evidence.stderrSnippet;
  return detail;
}

function retainedDiagnostics(
  error: RuntimeSafeError,
  commandDiagnostic: ExternalCommandDiagnosticDetail,
): DiagnosticDetail[] {
  const diagnostics = (error.diagnosticDetails ?? []).filter(
    (detail) => detail.type !== "external_command",
  );
  return [...diagnostics, commandDiagnostic];
}

function classifyWorktrunkFailure(
  error: RuntimeSafeError,
  fallback: WorktrunkCommandFailureFallback,
): { code: WorktrunkProviderErrorCode; message: string; hint?: string } {
  if (fallback.code !== "WORKTRUNK_COMMAND_FAILED") {
    return fallback;
  }

  const diagnostic = stripVTControlCharacters(commandFailureText(error));
  const text = diagnostic.toLowerCase();
  if (isUnsupportedFlagText(text)) {
    return {
      code: "WORKTRUNK_UNSUPPORTED_FLAG",
      message: "Worktrunk rejected an automation flag used by STATION.",
      hint: "Upgrade Worktrunk or adjust worktree.worktrunk.use_lifecycle_hooks in STATION config.",
    };
  }

  if (isHookApprovalText(text)) {
    return {
      code: "WORKTRUNK_HOOK_APPROVAL_REQUIRED",
      message:
        "Worktrunk lifecycle hooks needed interactive approval during automated STATION work.",
      hint: "Set worktree.worktrunk.use_lifecycle_hooks to false to skip hooks or true to pre-approve hook prompts.",
    };
  }

  if (isDuplicateBranchText(text)) {
    return {
      code: "WORKTRUNK_BRANCH_EXISTS",
      message: "Worktrunk could not create the worktree because the branch already exists.",
      hint: "Choose a different branch name or start/focus the existing worktree.",
    };
  }

  if (isDuplicateWorktreeText(text)) {
    return {
      code: "WORKTRUNK_WORKTREE_EXISTS",
      message: "Worktrunk could not create the worktree because the worktree path already exists.",
      hint: "Choose a different branch/path or remove the stale worktree path.",
    };
  }

  if (
    fallback.unresolvedBase !== undefined &&
    unresolvedNamedReference(diagnostic) === fallback.unresolvedBase
  ) {
    return {
      code: "WORKTRUNK_BASE_MISSING",
      message: `Base \`${fallback.unresolvedBase}\` does not resolve to a commit.`,
      hint: "Create its first commit or choose another base.",
    };
  }

  if (isMissingBaseText(text)) {
    return {
      code: "WORKTRUNK_BASE_MISSING",
      message: "Worktrunk could not find the requested base for the new worktree.",
      hint: "Fetch the base branch or set a valid worktree.worktrunk.base/default branch in STATION config.",
    };
  }

  return fallback;
}

function commandFailureText(error: RuntimeSafeError): string {
  const parts = [error.message];
  for (const detail of error.diagnosticDetails ?? []) {
    if (detail.type !== "external_command") continue;
    parts.push(detail.command);
    if (detail.stdoutSnippet !== undefined) parts.push(detail.stdoutSnippet);
    if (detail.stderrSnippet !== undefined) parts.push(detail.stderrSnippet);
  }
  return parts.join("\n");
}

function isUnsupportedFlagText(text: string): boolean {
  return (
    /unknown (?:argument|flag|option).*--(?:no-hooks|yes)/.test(text) ||
    /unrecognized (?:argument|flag|option).*--(?:no-hooks|yes)/.test(text) ||
    /unexpected (?:argument|flag|option).*--(?:no-hooks|yes)/.test(text) ||
    /found argument ['"]--(?:no-hooks|yes)['"].*(?:not expected|wasn't expected)/.test(text) ||
    /invalid (?:argument|flag|option).*--(?:no-hooks|yes)/.test(text)
  );
}

function isHookApprovalText(text: string): boolean {
  return (
    /(?:approval|confirm|confirmation|prompt).*(?:required|needed)/.test(text) ||
    /(?:requires|needs).*(?:approval|confirmation|interactive)/.test(text) ||
    /(?:use|pass).*(?:--yes|-y).*(?:approve|confirm|continue)/.test(text) ||
    /not a tty/.test(text) ||
    /hook.*(?:cancelled|aborted|declined|refused)/.test(text)
  );
}

function isDuplicateBranchText(text: string): boolean {
  return (
    /branch\b.*\balready exists/.test(text) ||
    /\balready exists\b.*\bbranch\b/.test(text) ||
    /refs\/heads\/[^\s]+.*\balready exists/.test(text)
  );
}

function isDuplicateWorktreeText(text: string): boolean {
  return (
    /worktree\b.*\balready exists/.test(text) ||
    /\balready exists\b.*\bworktree\b/.test(text) ||
    /\bpath\b.*\balready exists/.test(text) ||
    /\bdestination\b.*\balready exists/.test(text)
  );
}

function unresolvedNamedReference(text: string): string | undefined {
  return /no branch, tag, or commit named ['"]?([^'"\s]+)['"]?/i.exec(text)?.[1];
}

function isMissingBaseText(text: string): boolean {
  return (
    /base\b.*\b(?:not found|missing|does not exist|unknown)/.test(text) ||
    /(?:not found|missing|does not exist|unknown)\b.*\bbase\b/.test(text) ||
    /could(?:n't| not) find remote ref/.test(text) ||
    /invalid reference/.test(text) ||
    /not a valid object name/.test(text) ||
    /unknown revision/.test(text)
  );
}
