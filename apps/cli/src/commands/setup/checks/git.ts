import { realpath } from "node:fs/promises";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { findGitRoot } from "@station/config";
import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  environmentWithoutGitLocals,
  externalCommandDiagnosticFromSafeError,
  gitLocalEnvironmentVariables,
  isSafeError,
  runExternalCommand,
} from "@station/runtime";
import type { CliEnv } from "../../../env.js";
import type { SetupGitFact } from "../model.js";
import { setupProbeTimeoutMs } from "./constants.js";
import { commandEnv } from "./env.js";

export type CheckGitOptions = {
  runner?: ExternalCommandRunner;
  env?: CliEnv;
  cwd?: string;
};

const defaultBranch = "main";
const outsideRepositoryMessage = "Git is available; choose a project explicitly in STATION.";
const gitAbsentMessage =
  "Git is not installed. Install Git (on macOS, xcode-select --install provides it), then run stn setup check.";
const gitUnusableMessage =
  "Git is installed but unusable. On macOS run xcode-select --install or configure a working custom Git; otherwise repair or reinstall Git. Then run stn setup check.";

type MissingGitFact = Extract<SetupGitFact, { status: "missing" }>;

type GitCapabilityAssessment =
  | { status: "available" }
  | { status: "unavailable"; fact: MissingGitFact };

export async function checkSetupGit(options: CheckGitOptions = {}): Promise<SetupGitFact> {
  const capability = await probeGitCapability(options);
  if (capability.status === "unavailable") return capability.fact;
  return probeGitRepository(options, options.cwd ?? process.cwd());
}

async function probeGitCapability(options: CheckGitOptions): Promise<GitCapabilityAssessment> {
  try {
    const version = await git(options, ["--version"]);
    if (!isGitVersionOutput(version.stdout)) {
      return { status: "unavailable", fact: unusableGitFact() };
    }
    return { status: "available" };
  } catch (error) {
    if (isSafeError(error) && error.code === "ENOENT") {
      return { status: "unavailable", fact: absentGitFact() };
    }
    return { status: "unavailable", fact: unusableGitFact() };
  }
}

async function probeGitRepository(options: CheckGitOptions, cwd: string): Promise<SetupGitFact> {
  try {
    const rootResult = await git(options, ["rev-parse", "--show-toplevel"], cwd);
    const root = rootResult.stdout.trim();
    if (root.length === 0) return unusableRepositoryFact(cwd);

    const detectedDefaultBranch = await detectDefaultBranch(options, root);
    return {
      status: "ok",
      repository: "present",
      root,
      defaultBranch: detectedDefaultBranch,
      repoName: basename(root) || "project",
    };
  } catch (error) {
    const failureText = gitFailureText(error);
    if (isDubiousOwnershipError(failureText)) {
      return {
        status: "missing",
        reason: "dubious-ownership",
        defaultBranch,
        message: dubiousOwnershipMessage(failureText, cwd),
      };
    }
    const stderr = gitFailureStderr(error);
    if (
      isFilesystemBoundaryNotRepositoryError(stderr) ||
      (isCanonicalNotRepositoryError(stderr) &&
        (await findDiscoverableGitRoot(cwd, options.env ?? process.env)) === undefined)
    ) {
      return {
        status: "ok",
        repository: "absent",
        defaultBranch,
        message: outsideRepositoryMessage,
      };
    }
    return unusableRepositoryFact(cwd);
  }
}

function absentGitFact(): MissingGitFact {
  return {
    status: "missing",
    reason: "git-absent",
    defaultBranch,
    message: gitAbsentMessage,
  };
}

function unusableGitFact(): MissingGitFact {
  return {
    status: "missing",
    reason: "git-unusable",
    defaultBranch,
    message: gitUnusableMessage,
  };
}

function unusableRepositoryFact(cwd: string): MissingGitFact {
  return {
    status: "missing",
    reason: "repository-unusable",
    defaultBranch,
    message: `Git could not read repository metadata from ${cwd}. Repair its metadata, permissions, or Git configuration, then run stn setup check.`,
  };
}

function isGitVersionOutput(stdout: string): boolean {
  return /^git version \S+(?: [^\r\n]+)?$/.test(stdout.trim());
}

function isDubiousOwnershipError(failureText: string): boolean {
  return /dubious ownership|safe\.directory/i.test(failureText);
}

function isCanonicalNotRepositoryError(stderr: string): boolean {
  return /^fatal: not a git repository \(or any of the parent directories\): \.git$/m.test(stderr);
}

function isFilesystemBoundaryNotRepositoryError(stderr: string): boolean {
  return /^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.$/m.test(
    stderr,
  );
}

function dubiousOwnershipMessage(failureText: string, cwd: string): string {
  const repository =
    failureText.match(/^fatal: detected dubious ownership in repository at '(.*)'\r?$/im)?.[1] ??
    cwd;
  return `Git refused this repository for dubious ownership. Review its ownership, then run git config --global --add safe.directory ${quoteCommandPart(repository)}, then run stn setup check.`;
}

async function findDiscoverableGitRoot(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const root = await findGitRoot(cwd);
  if (root === undefined) return undefined;

  const ceilings = await gitCeilingDirectories(env.GIT_CEILING_DIRECTORIES);
  if (ceilings.length === 0) return root;

  const [canonicalCwd, canonicalRoot] = await Promise.all([
    canonicalExistingPath(cwd),
    canonicalExistingPath(root),
  ]);
  const blocked = ceilings.some(
    (ceiling) =>
      isStrictAncestor(ceiling, canonicalCwd) && isSameOrAncestor(canonicalRoot, ceiling),
  );
  return blocked ? undefined : root;
}

async function gitCeilingDirectories(value: string | undefined): Promise<string[]> {
  if (value === undefined) return [];

  const ceilings: string[] = [];
  let skipCanonicalization = false;
  for (const entry of value.split(delimiter)) {
    if (entry.length === 0) {
      skipCanonicalization = true;
    } else if (isAbsolute(entry)) {
      if (skipCanonicalization) {
        ceilings.push(resolve(entry));
      } else {
        try {
          ceilings.push(await realpath(entry));
        } catch {
          // Git discards ceiling entries that cannot be canonicalized.
        }
      }
    }
  }
  return ceilings;
}

async function canonicalExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isStrictAncestor(ancestor: string, path: string): boolean {
  return ancestor !== path && isSameOrAncestor(ancestor, path);
}

function isSameOrAncestor(ancestor: string, path: string): boolean {
  const descendant = relative(ancestor, path);
  return (
    descendant.length === 0 ||
    (descendant !== ".." && !descendant.startsWith(`..${sep}`) && !isAbsolute(descendant))
  );
}

function gitFailureText(error: unknown): string {
  if (!isSafeError(error)) return "";
  const diagnostic = externalCommandDiagnosticFromSafeError(error);
  return [error.message, diagnostic?.stdoutSnippet, diagnostic?.stderrSnippet]
    .filter((part) => part !== undefined)
    .join("\n");
}

function gitFailureStderr(error: unknown): string {
  if (!isSafeError(error)) return "";
  return externalCommandDiagnosticFromSafeError(error)?.stderrSnippet ?? "";
}

async function detectDefaultBranch(options: CheckGitOptions, root: string): Promise<string> {
  try {
    const originHead = await git(
      options,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      root,
    );
    const branch = originHead.stdout.trim().replace(/^origin\//, "");
    if (branch.length > 0) {
      return branch;
    }
  } catch {
    // Fall through to the current branch because remote metadata is best-effort.
  }

  try {
    const current = await git(options, ["rev-parse", "--abbrev-ref", "HEAD"], root);
    const branch = current.stdout.trim();
    if (branch.length > 0 && branch !== "HEAD") {
      return branch;
    }
  } catch {
    // Fall through to the stable default because branch metadata is best-effort.
  }

  return defaultBranch;
}

function git(options: CheckGitOptions, args: string[], cwd?: string) {
  const sanitizedEnv = environmentWithoutGitLocals(options.env ?? process.env);
  const input: ExternalCommandInput = {
    command: "git",
    args,
    env: {
      ...commandEnv(sanitizedEnv),
      LANG: "C",
      LC_ALL: "C",
    },
    unsetEnv: gitLocalEnvironmentVariables,
    timeoutMs: setupProbeTimeoutMs,
    maxOutputChars: 4096,
  };
  if (cwd !== undefined) input.cwd = cwd;
  return runExternalCommand(input, options.runner);
}

function quoteCommandPart(part: string): string {
  return `'${part.replaceAll("'", `'\\''`)}'`;
}
