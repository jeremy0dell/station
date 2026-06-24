import { normalize } from "node:path";
import type { RepositoryRemote } from "@station/contracts";
import { type RuntimeClock, systemClock, toIsoTimestamp } from "@station/runtime";

export type RepositoryGitWorktree = {
  id: string;
  projectId: string;
  path: string;
  branch: string;
  state?: string;
  remote?: RepositoryRemote;
  headSha?: string;
};

export type RepositoryGitContext = {
  worktreeId: string;
  projectId: string;
  path: string;
  branch: string;
  headSha: string;
  remote: RepositoryRemote;
  checkedAt: string;
};

export type ReadRepositoryGitContextInput = {
  worktree: RepositoryGitWorktree;
  clock?: RuntimeClock;
};

export function readRepositoryGitContext(
  input: ReadRepositoryGitContextInput,
): RepositoryGitContext | undefined {
  const { worktree } = input;
  if (worktree.state !== undefined && worktree.state !== "exists") {
    return undefined;
  }
  if (worktree.remote === undefined || worktree.headSha === undefined) {
    return undefined;
  }

  const clock = input.clock ?? systemClock;
  return {
    worktreeId: worktree.id,
    projectId: worktree.projectId,
    path: normalize(worktree.path),
    branch: worktree.branch,
    headSha: worktree.headSha,
    remote: worktree.remote,
    checkedAt: toIsoTimestamp(clock.now()),
  };
}

export function repositoryMetadataCacheKey(input: {
  kind: "pull_request" | "checks";
  worktreeId: string;
  path: string;
  host: string;
  owner: string;
  repo: string;
  branch: string;
  headSha: string;
  pullRequestNumber?: number;
}): string {
  const key: {
    kind: "pull_request" | "checks";
    worktreeId: string;
    path: string;
    host: string;
    owner: string;
    repo: string;
    branch: string;
    headSha: string;
    pullRequestNumber?: number;
  } = {
    kind: input.kind,
    worktreeId: input.worktreeId,
    path: normalize(input.path),
    host: input.host.toLowerCase(),
    owner: input.owner.toLowerCase(),
    repo: input.repo.toLowerCase(),
    branch: input.branch,
    headSha: input.headSha.toLowerCase(),
  };
  if (input.pullRequestNumber !== undefined) {
    key.pullRequestNumber = input.pullRequestNumber;
  }
  return JSON.stringify(key);
}
