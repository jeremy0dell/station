import type {
  ProviderDoctorCheck,
  ProviderHealth,
  RepositoryCapabilities,
  RepositoryChecksRequest,
  RepositoryProvider,
  RepositoryPullRequestRequest,
  RepositoryRemote,
  SafeError,
  WorktreeChecksState,
  WorktreeChecksSummary,
  WorktreePullRequest,
} from "@station/contracts";
import {
  RepositoryChecksRequestSchema,
  RepositoryPullRequestRequestSchema,
  WorktreeChecksSummarySchema,
  WorktreePullRequestSchema,
} from "@station/contracts";
import {
  type ExternalCommandRunner,
  type RuntimeClock,
  redactCommandOutput,
  runExternalCommand,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { z } from "zod";

export type GithubRepositoryProviderOptions = {
  command?: string;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
  clock?: RuntimeClock;
};

const capabilities: RepositoryCapabilities = {
  canDiscoverPullRequests: true,
  canReadChecks: true,
  canUseCliAuth: true,
};

const defaultTimeoutMs = 3000;
const checksStatusExitCodes = [1, 8];

const GithubPullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    baseRefName: z.string().nullable().optional(),
    headRefName: z.string().nullable().optional(),
    headRefOid: z.string().nullable().optional(),
    isDraft: z.boolean().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    headRepository: z.unknown().optional(),
    headRepositoryOwner: z.unknown().optional(),
  })
  .strict();

const GithubPullRequestListSchema = z.array(GithubPullRequestSchema);

type GithubPullRequest = z.infer<typeof GithubPullRequestSchema>;

const GithubCheckSchema = z
  .object({
    bucket: z.string().nullable().optional(),
    link: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    workflow: z.string().nullable().optional(),
    startedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
  })
  .strict();

const GithubChecksSchema = z.array(GithubCheckSchema);

type GithubCheck = z.infer<typeof GithubCheckSchema>;

export class GithubRepositoryProvider implements RepositoryProvider {
  readonly id = "github";

  readonly #command: string;
  readonly #timeoutMs: number;
  readonly #runner: ExternalCommandRunner | undefined;
  readonly #clock: RuntimeClock;
  #health: ProviderHealth | undefined;

  constructor(options: GithubRepositoryProviderOptions = {}) {
    this.#command = options.command ?? process.env.STATION_GH_BIN ?? "gh";
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
  }

  capabilities(): RepositoryCapabilities {
    return capabilities;
  }

  async health(): Promise<ProviderHealth> {
    return (
      this.#health ?? {
        providerId: this.id,
        providerType: "repository",
        status: "unknown",
        lastCheckedAt: this.#now(),
        capabilities,
      }
    );
  }

  async doctorChecks(): Promise<ProviderDoctorCheck[]> {
    try {
      await this.#run(["auth", "status"]);
      this.#recordHealth("healthy", undefined, { auth: "gh auth status succeeded" });
      return [
        {
          name: "github.auth",
          status: "ok",
          message: "GitHub CLI authentication is available.",
        },
      ];
    } catch (error) {
      const safeError = githubRepositoryErrorFromUnknown(error);
      this.#recordHealth(errorHealthStatus(safeError), safeError);
      return [
        {
          name: "github.auth",
          status: "warn",
          message: "GitHub CLI authentication is unavailable.",
          error: safeError,
        },
      ];
    }
  }

  async discoverPullRequest(
    request: RepositoryPullRequestRequest,
  ): Promise<WorktreePullRequest | null> {
    const parsed = parsePullRequestRequest(request);
    try {
      const result = await this.#run(
        [
          "pr",
          "list",
          "--repo",
          ghRepo(parsed.remote),
          "--head",
          parsed.branch,
          "--state",
          "all",
          "--limit",
          "5",
          "--json",
          [
            "number",
            "url",
            "state",
            "baseRefName",
            "headRefName",
            "headRefOid",
            "isDraft",
            "updatedAt",
            "headRepository",
            "headRepositoryOwner",
          ].join(","),
        ],
        request.signal,
      );
      const candidates = GithubPullRequestListSchema.parse(JSON.parse(result.stdout));
      const selected = selectPullRequest(candidates, parsed);
      this.#recordHealth("healthy");
      return selected === undefined
        ? null
        : WorktreePullRequestSchema.parse(
            toWorktreePullRequest(selected, parsed.remote, this.#now()),
          );
    } catch (error) {
      const safeError = githubRepositoryErrorFromUnknown(error);
      this.#recordHealth(errorHealthStatus(safeError), safeError);
      throw safeError;
    }
  }

  async readChecks(request: RepositoryChecksRequest): Promise<WorktreeChecksSummary | null> {
    const parsed = parseChecksRequest(request);
    try {
      const result = await this.#run(
        [
          "pr",
          "checks",
          String(parsed.pullRequestNumber),
          "--repo",
          ghRepo(parsed.remote),
          "--json",
          ["bucket", "link", "name", "state", "workflow", "startedAt", "completedAt"].join(","),
        ],
        request.signal,
        { allowedExitCodes: checksStatusExitCodes },
      );
      const checks = parseGithubJson(GithubChecksSchema, result);
      this.#recordHealth("healthy");
      return WorktreeChecksSummarySchema.parse(toChecksSummary(checks, this.#now()));
    } catch (error) {
      const safeError = githubRepositoryErrorFromUnknown(error);
      this.#recordHealth(errorHealthStatus(safeError), safeError);
      throw safeError;
    }
  }

  async #run(args: string[], signal?: AbortSignal, options: { allowedExitCodes?: number[] } = {}) {
    const input: Parameters<typeof runExternalCommand>[0] = {
      command: this.#command,
      args,
      timeoutMs: this.#timeoutMs,
      maxOutputChars: 64 * 1024,
    };
    if (signal !== undefined) input.signal = signal;
    if (options.allowedExitCodes !== undefined) {
      input.allowedExitCodes = options.allowedExitCodes;
    }
    return runExternalCommand(input, this.#runner);
  }

  #now(): string {
    return toIsoTimestamp(this.#clock.now());
  }

  #recordHealth(
    status: ProviderHealth["status"],
    lastError?: SafeError,
    diagnostics?: Record<string, string>,
  ): void {
    const health: ProviderHealth = {
      providerId: this.id,
      providerType: "repository",
      status,
      lastCheckedAt: this.#now(),
      capabilities,
    };
    if (lastError !== undefined) health.lastError = lastError;
    if (diagnostics !== undefined) health.diagnostics = diagnostics;
    this.#health = health;
  }
}

function parsePullRequestRequest(request: RepositoryPullRequestRequest) {
  const wireRequest: z.infer<typeof RepositoryPullRequestRequestSchema> = {
    remote: request.remote,
    branch: request.branch,
  };
  if (request.headSha !== undefined) wireRequest.headSha = request.headSha;
  if (request.worktreeId !== undefined) wireRequest.worktreeId = request.worktreeId;
  if (request.projectId !== undefined) wireRequest.projectId = request.projectId;
  return RepositoryPullRequestRequestSchema.parse(wireRequest);
}

function parseChecksRequest(request: RepositoryChecksRequest) {
  const wireRequest: z.infer<typeof RepositoryChecksRequestSchema> = {
    remote: request.remote,
    pullRequestNumber: request.pullRequestNumber,
  };
  if (request.branch !== undefined) wireRequest.branch = request.branch;
  if (request.headSha !== undefined) wireRequest.headSha = request.headSha;
  if (request.worktreeId !== undefined) wireRequest.worktreeId = request.worktreeId;
  if (request.projectId !== undefined) wireRequest.projectId = request.projectId;
  return RepositoryChecksRequestSchema.parse(wireRequest);
}

function parseGithubJson<T>(schema: z.ZodType<T>, result: { stdout: string; stderr: string }): T {
  try {
    return schema.parse(JSON.parse(result.stdout));
  } catch (error) {
    const commandError = Object.assign(new Error("GitHub CLI command returned invalid JSON."), {
      stdout: result.stdout,
      stderr: result.stderr,
    });
    throw result.stderr.length > 0 || result.stdout.length === 0 ? commandError : error;
  }
}

function ghRepo(remote: RepositoryRemote): string {
  return `${remote.host}/${remote.owner}/${remote.repo}`;
}

function selectPullRequest(
  pullRequests: readonly GithubPullRequest[],
  request: z.infer<typeof RepositoryPullRequestRequestSchema>,
): GithubPullRequest | undefined {
  const branchMatches = pullRequests.filter(
    (pullRequest) => pullRequest.headRefName === request.branch,
  );
  const repoMatches = branchMatches.filter((pullRequest) =>
    pullRequestHeadRepositoryMatches(request.remote, pullRequest),
  );

  if (request.headSha !== undefined) {
    const headMatches = repoMatches.filter(
      (pullRequest) => normalizeSha(pullRequest.headRefOid) === normalizeSha(request.headSha),
    );
    if (headMatches.length === 1) {
      return headMatches[0];
    }
    if (headMatches.length > 1) {
      throw githubRepositoryError(
        "GITHUB_PULL_REQUEST_AMBIGUOUS",
        "GitHub returned multiple pull requests for the same branch and HEAD.",
      );
    }
  }

  if (repoMatches.length === 0) {
    return undefined;
  }
  if (repoMatches.length > 1) {
    throw githubRepositoryError(
      "GITHUB_PULL_REQUEST_AMBIGUOUS",
      "GitHub returned multiple pull requests for the same branch.",
    );
  }
  return repoMatches[0];
}

function pullRequestHeadRepositoryMatches(
  remote: RepositoryRemote,
  pullRequest: GithubPullRequest,
): boolean {
  const headRepository = repositoryNameWithOwner(pullRequest.headRepository);
  const headOwner = ownerLogin(pullRequest.headRepositoryOwner) ?? headRepository.owner;
  const headRepo = headRepository.repo;

  if (headOwner === undefined || headRepo === undefined) {
    return true;
  }

  return sameName(headOwner, remote.owner) && sameName(stripGitSuffix(headRepo), remote.repo);
}

function toWorktreePullRequest(
  pullRequest: GithubPullRequest,
  remote: RepositoryRemote,
  checkedAt: string,
): WorktreePullRequest {
  const result: WorktreePullRequest = {
    number: pullRequest.number,
    host: remote.host,
    checkedAt,
  };
  if (pullRequest.url !== undefined && pullRequest.url !== null && pullRequest.url.length > 0) {
    result.url = pullRequest.url;
  }
  const state = pullRequestState(pullRequest);
  if (state !== undefined) result.state = state;
  if (pullRequest.baseRefName !== undefined && pullRequest.baseRefName !== null) {
    result.baseRef = pullRequest.baseRefName;
  }
  if (pullRequest.headRefName !== undefined && pullRequest.headRefName !== null) {
    result.headRef = pullRequest.headRefName;
  }
  if (pullRequest.updatedAt !== undefined && pullRequest.updatedAt !== null) {
    result.updatedAt = pullRequest.updatedAt;
  }
  return result;
}

function pullRequestState(
  pullRequest: GithubPullRequest,
): WorktreePullRequest["state"] | undefined {
  if (pullRequest.isDraft === true) {
    return "draft";
  }
  const state = pullRequest.state?.toLowerCase();
  if (state === "open") return "open";
  if (state === "closed") return "closed";
  if (state === "merged") return "merged";
  if (state !== undefined) return "unknown";
  return undefined;
}

function toChecksSummary(checks: readonly GithubCheck[], checkedAt: string): WorktreeChecksSummary {
  const counts = checkCounts(checks);
  const summary: WorktreeChecksSummary = {
    state: checksState(counts),
    source: "github",
    checkedAt,
  };
  if (counts.total > 0) summary.total = counts.total;
  if (counts.passed > 0) summary.passed = counts.passed;
  if (counts.failed > 0) summary.failed = counts.failed;
  if (counts.pending > 0) summary.pending = counts.pending;
  if (counts.skipped > 0) summary.skipped = counts.skipped;
  if (counts.cancelled > 0) summary.cancelled = counts.cancelled;
  const url = checks.map((check) => check.link).find((link) => link !== undefined && link !== null);
  if (url !== undefined && url !== null && url.length > 0) summary.url = url;
  if (counts.unknown > 0) summary.reason = "GitHub returned unknown check buckets.";
  return summary;
}

type CheckCounts = {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  cancelled: number;
  unknown: number;
};

function checkCounts(checks: readonly GithubCheck[]): CheckCounts {
  const counts: CheckCounts = {
    total: checks.length,
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    cancelled: 0,
    unknown: 0,
  };

  for (const check of checks) {
    const bucket = normalizedBucket(check.bucket ?? check.state);
    if (bucket === "pass") counts.passed += 1;
    else if (bucket === "fail") counts.failed += 1;
    else if (bucket === "running") counts.pending += 1;
    else if (bucket === "skipped") counts.skipped += 1;
    else if (bucket === "cancelled") counts.cancelled += 1;
    else counts.unknown += 1;
  }

  return counts;
}

function normalizedBucket(value: string | null | undefined): WorktreeChecksState | undefined {
  const bucket = value?.toLowerCase();
  if (bucket === "pass" || bucket === "success") return "pass";
  if (bucket === "fail" || bucket === "failure" || bucket === "error") return "fail";
  if (bucket === "pending" || bucket === "running" || bucket === "queued") return "running";
  if (bucket === "skipping" || bucket === "skipped") return "skipped";
  if (bucket === "cancel" || bucket === "cancelled" || bucket === "canceled") return "cancelled";
  return undefined;
}

function checksState(counts: CheckCounts): WorktreeChecksState {
  if (counts.total === 0) return "none";
  if (counts.failed > 0) return "fail";
  if (counts.cancelled > 0) return "cancelled";
  if (counts.pending > 0) return "running";
  if (counts.unknown > 0) return "unknown";
  if (counts.passed > 0) return "pass";
  if (counts.skipped > 0) return "skipped";
  return "unknown";
}

function githubRepositoryErrorFromUnknown(error: unknown): SafeError {
  if (isSafeError(error) && error.tag === "RepositoryProviderError") {
    return error;
  }
  if (isSafeError(error) && error.code === "EXTERNAL_COMMAND_TIMEOUT") {
    return githubRepositoryError("GITHUB_COMMAND_TIMEOUT", "GitHub CLI command timed out.");
  }
  if (isSafeError(error) && error.code === "EXTERNAL_COMMAND_ABORTED") {
    return error;
  }

  const text = errorText(error);
  if (text.match(/rate limit|secondary rate limit|http 429/i)) {
    return githubRepositoryError(
      "GITHUB_RATE_LIMITED",
      "GitHub CLI request was rate limited.",
      "Wait for the GitHub rate limit to reset, then refresh metadata again.",
    );
  }
  if (text.match(/authentication|not logged in|gh auth login|http 401|http 403/i)) {
    return githubRepositoryError(
      "GITHUB_AUTH_UNAVAILABLE",
      "GitHub CLI authentication is unavailable.",
      "Run `gh auth status` or `gh auth login` to verify GitHub authentication.",
    );
  }
  if (text.match(/could not resolve|network|timed out|econnreset|enotfound|tls|http 5\d\d/i)) {
    return githubRepositoryError("GITHUB_NETWORK_FAILED", "GitHub CLI network request failed.");
  }
  if (text.match(/enoent|not found/i)) {
    return githubRepositoryError(
      "GITHUB_COMMAND_UNAVAILABLE",
      "GitHub CLI command is unavailable.",
      "Install `gh` or configure repository.github.command.",
    );
  }

  const safe = safeErrorFromUnknown(error, {
    tag: "RepositoryProviderError",
    code: "GITHUB_COMMAND_FAILED",
    message: "GitHub CLI command failed.",
    provider: "github",
  });
  return {
    tag: "RepositoryProviderError",
    code: safe.code === "EXTERNAL_COMMAND_TIMEOUT" ? "GITHUB_COMMAND_TIMEOUT" : safe.code,
    message: redactCommandOutput(safe.message),
    provider: "github",
  };
}

function githubRepositoryError(code: string, message: string, hint?: string): SafeError {
  const error: SafeError = {
    tag: "RepositoryProviderError",
    code,
    message,
    provider: "github",
  };
  if (hint !== undefined) error.hint = hint;
  return error;
}

function errorHealthStatus(error: SafeError): ProviderHealth["status"] {
  if (error.code === "GITHUB_COMMAND_UNAVAILABLE" || error.code === "GITHUB_AUTH_UNAVAILABLE") {
    return "unavailable";
  }
  return "degraded";
}

function isSafeError(value: unknown): value is SafeError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<SafeError>;
  return (
    typeof record.tag === "string" &&
    typeof record.code === "string" &&
    typeof record.message === "string"
  );
}

function errorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const record = error as Record<string, unknown>;
  return [record.message, record.code, record.stderr, record.stderrSnippet, record.stdoutSnippet]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function repositoryNameWithOwner(value: unknown): {
  owner?: string;
  repo?: string;
} {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const nameWithOwner = typeof record.nameWithOwner === "string" ? record.nameWithOwner : undefined;
  if (nameWithOwner !== undefined) {
    const [owner, repo] = nameWithOwner.split("/");
    if (owner !== undefined && repo !== undefined) {
      return { owner, repo };
    }
  }

  const repo = typeof record.name === "string" ? record.name : undefined;
  const owner = ownerLogin(record.owner);
  const result: {
    owner?: string;
    repo?: string;
  } = {};
  if (owner !== undefined) result.owner = owner;
  if (repo !== undefined) result.repo = repo;
  return result;
}

function ownerLogin(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.login === "string" ? record.login : undefined;
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function normalizeSha(value: string | null | undefined): string | undefined {
  return value?.toLowerCase();
}
