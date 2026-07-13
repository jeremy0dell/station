import { normalize } from "node:path";
import type {
  ProviderProjectConfig,
  SafeError,
  WorktreeChangeSummary,
  WorktreePullRequest,
} from "@station/contracts";
import { WorktreeChangeSummarySchema } from "@station/contracts";
import {
  type ExternalCommandRunner,
  type RuntimeClock,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { type GitCommandContext, runGitCommand, runOptionalGitCommand } from "./gitCommand.js";
import type {
  WorktreeChangeEvidence,
  WorktreeChangeReadInput,
  WorktreeChangeSource,
} from "./ports.js";

type LocalGitChangeSummaryInput = WorktreeChangeReadInput & {
  timeoutMs?: number;
  clock?: RuntimeClock;
  runner?: ExternalCommandRunner;
};

export type CreateLocalGitWorktreeChangeSourceOptions = {
  clock?: RuntimeClock;
  runner?: ExternalCommandRunner;
  timeoutMs?: number;
};

export type ParsedGitNumstat = {
  additions: number;
  deletions: number;
  filesChanged: number;
  binaryFiles: number;
};

type ResolvedBase = {
  ref: string;
  sha: string;
};

const defaultGitTimeoutMs = 200;

/**
 * ADAPTER
 *
 * Reads worktree change evidence through local Git while retaining command, timeout, and parsing mechanics.
 */
export function createLocalGitWorktreeChangeSource(
  options: CreateLocalGitWorktreeChangeSourceOptions = {},
): WorktreeChangeSource {
  return {
    read: (input) =>
      readLocalGitChangeSummary({
        ...input,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.runner === undefined ? {} : { runner: options.runner }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
  };
}

async function readLocalGitChangeSummary(
  input: LocalGitChangeSummaryInput,
): Promise<WorktreeChangeEvidence | undefined> {
  const clock = input.clock ?? systemClock;
  const checkedAt = toIsoTimestamp(clock.now());
  const command: GitCommandContext = {
    cwd: input.worktree.path,
    timeoutMs: input.timeoutMs ?? defaultGitTimeoutMs,
  };
  if (input.runner !== undefined) command.runner = input.runner;
  command.signal = input.signal;

  const headSha = await resolveRequiredRef(command, "HEAD", "HEAD");
  const remotes = await listRemotes(command);
  const baseInput: {
    command: GitCommandContext;
    project: ProviderProjectConfig;
    worktree: WorktreeChangeReadInput["worktree"];
    cachedPullRequest?: WorktreePullRequest;
    remotes: string[];
  } = {
    command,
    project: input.project,
    worktree: input.worktree,
    remotes,
  };
  if (input.cachedPullRequest !== undefined) {
    baseInput.cachedPullRequest = input.cachedPullRequest;
  }
  const base = await resolveBase(baseInput);
  if (base === undefined) {
    return undefined;
  }
  const mergeBaseSha = await resolveMergeBaseSha(command, base);

  const diff = await runGit(command, ["diff", "--numstat", `${mergeBaseSha}..HEAD`]);
  const parsed = parseGitNumstat(diff.stdout);
  const summaryInput: WorktreeChangeSummary = {
    kind: "branch_diff",
    additions: parsed.additions,
    deletions: parsed.deletions,
    filesChanged: parsed.filesChanged,
    binaryFiles: parsed.binaryFiles,
    baseRef: base.ref,
    baseSha: base.sha,
    mergeBaseSha,
    headRef: input.worktree.branch,
    headSha,
    source: "local_git",
    checkedAt,
  };
  const summary = WorktreeChangeSummarySchema.parse(summaryInput);

  return {
    summary,
    cacheKey: changeSummaryCacheKey({
      projectId: input.project.id,
      worktreeId: input.worktree.id,
      path: input.worktree.path,
      branch: input.worktree.branch,
      headSha,
      baseRef: base.ref,
      baseSha: base.sha,
      mergeBaseSha,
    }),
  };
}

export function parseGitNumstat(output: string): ParsedGitNumstat {
  let additions = 0;
  let deletions = 0;
  let filesChanged = 0;
  let binaryFiles = 0;

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length < 3) {
      throw localGitMetadataError("LOCAL_GIT_NUMSTAT_INVALID", "Git numstat output was malformed.");
    }

    const [rawAdditions, rawDeletions] = fields;
    if (rawAdditions === "-" || rawDeletions === "-") {
      if (rawAdditions !== "-" || rawDeletions !== "-") {
        throw localGitMetadataError(
          "LOCAL_GIT_NUMSTAT_INVALID",
          "Git numstat output mixed binary and numeric counts.",
        );
      }
      binaryFiles += 1;
      filesChanged += 1;
      continue;
    }

    const parsedAdditions = Number(rawAdditions);
    const parsedDeletions = Number(rawDeletions);
    if (
      !Number.isInteger(parsedAdditions) ||
      parsedAdditions < 0 ||
      !Number.isInteger(parsedDeletions) ||
      parsedDeletions < 0
    ) {
      throw localGitMetadataError(
        "LOCAL_GIT_NUMSTAT_INVALID",
        "Git numstat output contained invalid counts.",
      );
    }

    additions += parsedAdditions;
    deletions += parsedDeletions;
    filesChanged += 1;
  }

  return {
    additions,
    deletions,
    filesChanged,
    binaryFiles,
  };
}

export function changeSummaryCacheKey(input: {
  projectId: string;
  worktreeId: string;
  path: string;
  branch: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeBaseSha: string;
}): string {
  return JSON.stringify({
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    path: normalize(input.path),
    branch: input.branch,
    headSha: input.headSha,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    mergeBaseSha: input.mergeBaseSha,
  });
}

async function resolveBase(input: {
  command: GitCommandContext;
  project: ProviderProjectConfig;
  worktree: WorktreeChangeReadInput["worktree"];
  cachedPullRequest?: WorktreePullRequest;
  remotes: string[];
}): Promise<ResolvedBase | undefined> {
  const configuredBases = [
    input.cachedPullRequest?.baseRef ?? input.worktree.pullRequest?.baseRef,
    input.project.defaultBranch,
    input.project.worktrunk.base,
  ];

  for (const base of configuredBases) {
    if (base === undefined) {
      continue;
    }
    const resolved = await resolveConfiguredBase(input.command, base, input.remotes);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  const remoteDefault = await resolveRemoteDefaultBranch(input.command, input.remotes);
  if (remoteDefault !== undefined) {
    return remoteDefault;
  }

  return (
    (await resolveLocalBranch(input.command, "main")) ??
    (await resolveLocalBranch(input.command, "master"))
  );
}

async function resolveConfiguredBase(
  command: GitCommandContext,
  base: string,
  remotes: string[],
): Promise<ResolvedBase | undefined> {
  if (!isUnqualifiedBase(base, remotes)) {
    return resolveRef(command, base, base);
  }

  for (const candidate of configuredBaseCandidates(base, remotes)) {
    const resolved = await resolveRef(command, candidate.revParseRef, candidate.diffRef);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  return undefined;
}

function configuredBaseCandidates(
  base: string,
  remotes: string[],
): Array<{ revParseRef: string; diffRef: string }> {
  const candidates: Array<{ revParseRef: string; diffRef: string }> = [];
  if (remotes.includes("origin")) {
    candidates.push({
      revParseRef: `refs/remotes/origin/${base}`,
      diffRef: `origin/${base}`,
    });
  }
  const firstNonOrigin = remotes.find((remote) => remote !== "origin");
  if (firstNonOrigin !== undefined) {
    candidates.push({
      revParseRef: `refs/remotes/${firstNonOrigin}/${base}`,
      diffRef: `${firstNonOrigin}/${base}`,
    });
  }
  candidates.push({
    revParseRef: `refs/heads/${base}`,
    diffRef: base,
  });
  return candidates;
}

async function resolveRemoteDefaultBranch(
  command: GitCommandContext,
  remotes: string[],
): Promise<ResolvedBase | undefined> {
  const firstRemote = remotes.includes("origin") ? "origin" : remotes[0];
  if (firstRemote === undefined) {
    return undefined;
  }

  const symbolicRef = await runOptionalGit(command, [
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${firstRemote}/HEAD`,
  ]);
  const ref = symbolicRef?.trim();
  if (ref === undefined || ref.length === 0) {
    return undefined;
  }
  return resolveRef(command, ref, ref);
}

async function resolveLocalBranch(
  command: GitCommandContext,
  branch: "main" | "master",
): Promise<ResolvedBase | undefined> {
  return resolveRef(command, `refs/heads/${branch}`, branch);
}

async function resolveRequiredRef(
  command: GitCommandContext,
  revParseRef: string,
  displayRef: string,
): Promise<string> {
  const resolved = await resolveRef(command, revParseRef, displayRef);
  if (resolved === undefined) {
    throw localGitMetadataError("LOCAL_GIT_REF_UNRESOLVED", "Git ref could not be resolved.");
  }
  return resolved.sha;
}

async function resolveRef(
  command: GitCommandContext,
  revParseRef: string,
  displayRef: string,
): Promise<ResolvedBase | undefined> {
  const stdout = await runOptionalGit(command, [
    "rev-parse",
    "--verify",
    `${revParseRef}^{commit}`,
  ]);
  const sha = stdout?.trim();
  if (sha === undefined || sha.length === 0) {
    return undefined;
  }
  return {
    ref: displayRef,
    sha,
  };
}

async function resolveMergeBaseSha(
  command: GitCommandContext,
  base: ResolvedBase,
): Promise<string> {
  const result = await runGit(command, ["merge-base", base.ref, "HEAD"]);
  const sha = result.stdout.trim();
  if (sha.length === 0) {
    throw localGitMetadataError(
      "LOCAL_GIT_MERGE_BASE_UNRESOLVED",
      "Git merge-base could not be resolved.",
    );
  }
  return sha;
}

async function listRemotes(command: GitCommandContext): Promise<string[]> {
  const stdout = await runOptionalGit(command, ["remote"]);
  if (stdout === undefined) {
    return [];
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function runOptionalGit(
  command: GitCommandContext,
  args: string[],
): Promise<string | undefined> {
  return (
    await runOptionalGitCommand(command, args, {
      maxOutputChars: 64 * 1024,
      errorOnNonZeroExit: () =>
        localGitMetadataError("LOCAL_GIT_COMMAND_FAILED", "Git command failed."),
    })
  )?.stdout;
}

async function runGit(command: GitCommandContext, args: string[]) {
  return runGitCommand(command, args, {
    maxOutputChars: 64 * 1024,
    errorOnNonZeroExit: () =>
      localGitMetadataError("LOCAL_GIT_COMMAND_FAILED", "Git command failed."),
  });
}

function isUnqualifiedBase(base: string, remotes: string[]): boolean {
  if (base.startsWith("refs/")) {
    return false;
  }
  if (base.startsWith("origin/")) {
    return false;
  }
  return !remotes.some((remote) => base.startsWith(`${remote}/`));
}

function localGitMetadataError(code: string, message: string): SafeError {
  return {
    tag: "LocalGitMetadataError",
    code,
    message,
  };
}
