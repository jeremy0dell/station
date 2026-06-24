import { basename } from "node:path";
import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
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

export async function checkSetupGit(options: CheckGitOptions = {}): Promise<SetupGitFact> {
  try {
    const rootResult = await git(options, ["rev-parse", "--show-toplevel"]);
    const root = rootResult.stdout.trim();
    const defaultBranch = await detectDefaultBranch(options);
    return {
      status: "ok",
      root,
      defaultBranch,
      repoName: basename(root) || "project",
    };
  } catch {
    return {
      status: "missing",
      defaultBranch: "main",
      message: "Run station setup from inside the git repository you want to manage.",
    };
  }
}

async function detectDefaultBranch(options: CheckGitOptions): Promise<string> {
  try {
    const originHead = await git(options, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const branch = originHead.stdout.trim().replace(/^origin\//, "");
    if (branch.length > 0) {
      return branch;
    }
  } catch {
    // fall through to current branch
  }

  try {
    const current = await git(options, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = current.stdout.trim();
    if (branch.length > 0 && branch !== "HEAD") {
      return branch;
    }
  } catch {
    // fall through to stable default
  }

  return "main";
}

function git(options: CheckGitOptions, args: string[]) {
  const input: ExternalCommandInput = {
    command: "git",
    args,
    timeoutMs: setupProbeTimeoutMs,
    maxOutputChars: 4096,
  };
  if (options.cwd !== undefined) input.cwd = options.cwd;
  const env = commandEnv(options.env);
  if (env !== undefined) input.env = env;
  return runExternalCommand(input, options.runner);
}
