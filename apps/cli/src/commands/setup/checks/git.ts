import { basename } from "node:path";
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
    if (isCanonicalNotRepositoryError(gitFailureStderr(error))) {
      // A marker means Git discovered repository intent but could not read its metadata.
      if ((await findGitRoot(cwd)) === undefined) {
        return {
          status: "ok",
          repository: "absent",
          defaultBranch,
          message: outsideRepositoryMessage,
        };
      }
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

function dubiousOwnershipMessage(failureText: string, cwd: string): string {
  const repository =
    failureText.match(/dubious ownership in repository at ['"]([^'"]+)['"]/i)?.[1] ?? cwd;
  return `Git refused this repository for dubious ownership. Review its ownership, then run git config --global --add safe.directory ${quoteCommandPart(repository)}, then run stn setup check.`;
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
