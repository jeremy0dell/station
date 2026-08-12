import { WorktrunkProviderError } from "./errors.js";

export type GitWorktreeRemovalEvidence = {
  path: string;
  branch?: string;
  state: "exists" | "missing";
};

export function parseGitWorktreeRemovalEvidence(stdout: string): GitWorktreeRemovalEvidence[] {
  const evidence: GitWorktreeRemovalEvidence[] = [];
  let path: string | undefined;
  let head: string | undefined;
  let branch: string | undefined;
  let missing = false;

  const finish = () => {
    if (path === undefined) {
      if (head !== undefined || branch !== undefined || missing) {
        throw invalidGitWorktreeOutput();
      }
      return;
    }
    const item: GitWorktreeRemovalEvidence = {
      path,
      state: missing ? "missing" : "exists",
    };
    const resolvedBranch = branchFromGitEvidence(branch, head);
    if (resolvedBranch !== undefined) item.branch = resolvedBranch;
    evidence.push(item);
    path = undefined;
    head = undefined;
    branch = undefined;
    missing = false;
  };

  for (const field of stdout.split("\0")) {
    if (field.length === 0) {
      finish();
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? undefined : field.slice(separator + 1);
    if (key === "worktree") {
      if (path !== undefined || value === undefined || value.length === 0) {
        throw invalidGitWorktreeOutput();
      }
      path = value;
    } else if (key === "HEAD") {
      head = value;
    } else if (key === "branch") {
      branch = value;
    } else if (key === "prunable") {
      missing = true;
    }
  }
  finish();
  return evidence;
}

function branchFromGitEvidence(branch: string | undefined, head: string | undefined) {
  if (branch?.startsWith("refs/heads/") === true) {
    return branch.slice("refs/heads/".length);
  }
  return head === undefined ? undefined : `detached:${head.slice(0, 12)}`;
}

function invalidGitWorktreeOutput(): WorktrunkProviderError {
  return new WorktrunkProviderError(
    "WORKTRUNK_INVALID_OUTPUT",
    "Git worktree output could not safely revalidate the removal target.",
  );
}
