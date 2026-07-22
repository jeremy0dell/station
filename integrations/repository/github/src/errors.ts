import type { DiagnosticDetail, ProviderHealth, SafeError } from "@station/contracts";
import { type RuntimeSafeError, safeErrorFromUnknown } from "@station/runtime";

export type GithubRepositoryProviderErrorCode =
  | "EXTERNAL_COMMAND_ABORTED"
  | "EXTERNAL_COMMAND_FAILED"
  | "GITHUB_AUTH_UNAVAILABLE"
  | "GITHUB_COMMAND_FAILED"
  | "GITHUB_COMMAND_TIMEOUT"
  | "GITHUB_COMMAND_UNAVAILABLE"
  | "GITHUB_NETWORK_FAILED"
  | "GITHUB_PULL_REQUEST_AMBIGUOUS"
  | "GITHUB_RATE_LIMITED";

export class GithubRepositoryProviderError extends Error implements SafeError {
  readonly tag = "RepositoryProviderError";
  readonly provider = "github";
  readonly code: GithubRepositoryProviderErrorCode;
  readonly hint?: string;
  readonly diagnosticDetails?: DiagnosticDetail[];

  constructor(
    code: GithubRepositoryProviderErrorCode,
    message: string,
    options: {
      hint?: string;
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
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.diagnosticDetails !== undefined) {
      this.diagnosticDetails = options.diagnosticDetails;
    }
  }
}

export function githubRepositoryErrorFromUnknown(error: unknown): GithubRepositoryProviderError {
  if (error instanceof GithubRepositoryProviderError) {
    return error;
  }
  const normalized = safeErrorFromUnknown(error, {
    tag: "RepositoryProviderError",
    code: "GITHUB_COMMAND_FAILED",
    message: "GitHub CLI command failed.",
    provider: "github",
  });
  const options = providerErrorOptions(normalized);

  if (normalized.code === "EXTERNAL_COMMAND_TIMEOUT") {
    return new GithubRepositoryProviderError(
      "GITHUB_COMMAND_TIMEOUT",
      "GitHub CLI command timed out.",
      options,
    );
  }
  if (normalized.code === "EXTERNAL_COMMAND_ABORTED" || normalized.tag === "CancellationError") {
    return new GithubRepositoryProviderError(
      "EXTERNAL_COMMAND_ABORTED",
      "External command was aborted.",
      options,
    );
  }

  const text = githubFailureText(normalized);
  if (/rate limit|secondary rate limit|http 429/i.test(text)) {
    return new GithubRepositoryProviderError(
      "GITHUB_RATE_LIMITED",
      "GitHub CLI request was rate limited.",
      {
        ...options,
        hint: "Wait for the GitHub rate limit to reset, then refresh metadata again.",
      },
    );
  }
  if (/authentication|not logged in|gh auth login|http 401|http 403/i.test(text)) {
    return new GithubRepositoryProviderError(
      "GITHUB_AUTH_UNAVAILABLE",
      "GitHub CLI authentication is unavailable.",
      {
        ...options,
        hint: "Run `gh auth status` or `gh auth login` to verify GitHub authentication.",
      },
    );
  }
  if (/could not resolve|network|timed out|econnreset|enotfound|tls|http 5\d\d/i.test(text)) {
    return new GithubRepositoryProviderError(
      "GITHUB_NETWORK_FAILED",
      "GitHub CLI network request failed.",
      options,
    );
  }
  if (normalized.code === "ENOENT" || /enoent|not found/i.test(text)) {
    return new GithubRepositoryProviderError(
      "GITHUB_COMMAND_UNAVAILABLE",
      "GitHub CLI command is unavailable.",
      {
        ...options,
        hint: "Install `gh` or configure repository.github.command.",
      },
    );
  }

  if (normalized.code === "EXTERNAL_COMMAND_FAILED") {
    return new GithubRepositoryProviderError(
      "EXTERNAL_COMMAND_FAILED",
      normalized.message,
      options,
    );
  }
  return new GithubRepositoryProviderError("GITHUB_COMMAND_FAILED", normalized.message, options);
}

export function githubRepositoryError(
  code: GithubRepositoryProviderErrorCode,
  message: string,
  hint?: string,
): GithubRepositoryProviderError {
  return new GithubRepositoryProviderError(code, message, {
    ...(hint === undefined ? {} : { hint }),
  });
}

export function githubErrorHealthStatus(error: SafeError): ProviderHealth["status"] {
  if (error.code === "GITHUB_COMMAND_UNAVAILABLE" || error.code === "GITHUB_AUTH_UNAVAILABLE") {
    return "unavailable";
  }
  return "degraded";
}

function providerErrorOptions(normalized: RuntimeSafeError): {
  cause: RuntimeSafeError;
  diagnosticDetails?: DiagnosticDetail[];
} {
  const options: {
    cause: RuntimeSafeError;
    diagnosticDetails?: DiagnosticDetail[];
  } = { cause: normalized };
  if (normalized.diagnosticDetails !== undefined) {
    options.diagnosticDetails = normalized.diagnosticDetails;
  }
  return options;
}

function githubFailureText(error: RuntimeSafeError): string {
  const text = [error.message, error.code];
  for (const detail of error.diagnosticDetails ?? []) {
    if (detail.type !== "external_command") continue;
    text.push(detail.command);
    if (detail.stdoutSnippet !== undefined) text.push(detail.stdoutSnippet);
    if (detail.stderrSnippet !== undefined) text.push(detail.stderrSnippet);
  }
  return text.join("\n");
}
