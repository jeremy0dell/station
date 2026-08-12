import { WorktrunkProviderError } from "./errors.js";

export type GitWorktreeRemovalEvidence = {
  path: string;
  headSha: string;
  branch: string;
  state: "exists" | "missing";
  isPrimaryCheckout: boolean;
};

export type GitCheckoutRemovalIdentity = {
  path: string;
  commonDir: string;
  headSha: string;
  branch: string;
};

export function parseGitCheckoutRemovalIdentity(stdout: string): GitCheckoutRemovalIdentity {
  const fields = stdout.trimEnd().split("\n");
  const [path, commonDir, headSha, branchRef] = fields;
  if (
    fields.length !== 4 ||
    path === undefined ||
    path.length === 0 ||
    commonDir === undefined ||
    commonDir.length === 0 ||
    headSha === undefined ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(headSha) ||
    branchRef === undefined ||
    (branchRef !== "HEAD" && !branchRef.startsWith("refs/heads/"))
  ) {
    throw invalidGitWorktreeOutput();
  }
  return {
    path,
    commonDir,
    headSha,
    branch:
      branchRef === "HEAD"
        ? `detached:${headSha.slice(0, 12)}`
        : branchRef.slice("refs/heads/".length),
  };
}

export function parseGitCommonDirectory(stdout: string): string {
  const commonDir = stdout.trimEnd();
  if (commonDir.length === 0 || commonDir.includes("\n")) {
    throw invalidGitWorktreeOutput();
  }
  return commonDir;
}

export function parseGitWorktreeRemovalEvidence(stdout: string): GitWorktreeRemovalEvidence[] {
  const evidence: GitWorktreeRemovalEvidence[] = [];
  let path: string | undefined;
  let headSha: string | undefined;
  let branchRef: string | undefined;
  let missing = false;

  const finish = () => {
    if (path === undefined) {
      if (headSha !== undefined || branchRef !== undefined || missing) {
        throw invalidGitWorktreeOutput();
      }
      return;
    }
    if (headSha === undefined || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(headSha)) {
      throw invalidGitWorktreeOutput();
    }
    evidence.push({
      path,
      headSha,
      branch: branchRef?.startsWith("refs/heads/")
        ? branchRef.slice("refs/heads/".length)
        : `detached:${headSha.slice(0, 12)}`,
      state: missing ? "missing" : "exists",
      isPrimaryCheckout: evidence.length === 0,
    });
    path = undefined;
    headSha = undefined;
    branchRef = undefined;
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
    switch (key) {
      case "worktree":
        if (path !== undefined || value === undefined || value.length === 0) {
          throw invalidGitWorktreeOutput();
        }
        path = value;
        break;
      case "HEAD":
        if (headSha !== undefined || value === undefined || value.length === 0) {
          throw invalidGitWorktreeOutput();
        }
        headSha = value;
        break;
      case "branch":
        if (branchRef !== undefined || value === undefined || value.length === 0) {
          throw invalidGitWorktreeOutput();
        }
        branchRef = value;
        break;
      case "prunable":
        missing = true;
        break;
    }
  }
  finish();
  return evidence;
}

function invalidGitWorktreeOutput(): WorktrunkProviderError {
  return new WorktrunkProviderError(
    "WORKTRUNK_INVALID_OUTPUT",
    "Git worktree output could not safely revalidate the removal target.",
  );
}
