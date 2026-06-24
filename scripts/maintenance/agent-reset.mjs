#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupRuntime } from "./agent-cleanup.mjs";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const home = homedir();

if (isMain()) {
  const options = parseResetArgs(process.argv.slice(2));
  await resetAgentState(options);
}

export async function resetAgentState(options) {
  await cleanupRuntime({
    dryRun: options.dryRun,
    localObserver: true,
    realE2e: true,
    tmux: true,
    verbose: options.verbose,
  });

  const managed = managedContext(options);
  const actions = [
    ...managedWorktreeActions(options, managed),
    ...managedDirectoryActions(options, managed),
    ...observerStateActions(options),
    ...configFixActions(options),
  ];

  printPlan("agent reset", actions, options.dryRun);
  for (const action of actions) {
    if (options.dryRun) {
      continue;
    }
    action.run();
  }
}

export function parseResetArgs(args) {
  const options = {
    dryRun: true,
    forceWorktrees: false,
    projectId: "station",
    allHomeWorktrees: false,
    state: false,
    fixConfig: false,
    verbose: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--run" || arg === "--yes") {
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force-worktrees") {
      options.forceWorktrees = true;
    } else if (arg === "--all-home-worktrees") {
      options.allHomeWorktrees = true;
    } else if (arg === "--state") {
      options.state = true;
    } else if (arg === "--fix-config") {
      options.fixConfig = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--project-id") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--project-id requires a value");
      }
      options.projectId = value;
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      printResetHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown reset option: ${arg}`);
    }
  }

  return options;
}

function managedContext(options) {
  const roots = managedRoots(options);
  const worktrees = listGitWorktrees()
    .filter((worktree) => roots.some((root) => isUnder(worktree.path, root)))
    .map((worktree) => ({
      ...worktree,
      status: worktreeStatus(worktree.path),
    }));
  return { roots, worktrees };
}

function managedWorktreeActions(options, managed) {
  const actions = [];
  for (const worktree of managed.worktrees) {
    if (worktree.status.length > 0 && !options.forceWorktrees) {
      actions.push({
        label: `skip dirty managed worktree ${worktree.path}`,
        run: () => undefined,
      });
      continue;
    }
    actions.push({
      label: `remove managed worktree ${worktree.path}`,
      run: () => {
        const args = ["worktree", "remove"];
        if (options.forceWorktrees) {
          args.push("--force");
        }
        args.push(worktree.path);
        spawnChecked("git", args, `git worktree remove ${worktree.path}`);
      },
    });
  }
  actions.push({
    label: "prune stale git worktree records",
    run: () => {
      spawnChecked("git", ["worktree", "prune"], "git worktree prune");
    },
  });
  return actions;
}

function managedDirectoryActions(options, managed) {
  const protectedWorktrees = options.forceWorktrees
    ? []
    : managed.worktrees.filter((worktree) => worktree.status.length > 0);
  return managed.roots.map((root) => {
    const hasProtectedWorktree = protectedWorktrees.some((worktree) =>
      isUnder(worktree.path, root),
    );
    if (hasProtectedWorktree) {
      return {
        label: `skip managed directory ${root} because a dirty worktree remains`,
        run: () => undefined,
      };
    }
    return {
      label: `remove managed directory ${root}`,
      run: () => {
        rmSync(root, { recursive: true, force: true });
      },
    };
  });
}

function observerStateActions(options) {
  if (!options.state) {
    return [];
  }
  const stateDir = join(home, ".local", "state", "station");
  return [
    {
      label: `remove observer state ${stateDir}`,
      run: () => {
        rmSync(stateDir, { recursive: true, force: true });
      },
    },
  ];
}

function configFixActions(options) {
  if (!options.fixConfig) {
    return [];
  }
  const configPath = join(home, ".config", "station", "config.toml");
  return [
    {
      label: `normalize local real config ${configPath}`,
      run: () => {
        if (!existsSync(configPath)) {
          return;
        }
        const next = normalizeConfig(readFileSync(configPath, "utf8"));
        writeFileSync(configPath, next);
      },
    },
  ];
}

export function normalizeConfig(input) {
  const lines = input
    .split(/\r?\n/)
    .filter((line) => !/^\s*profile\s*=\s*"default"\s*$/.test(line))
    .filter((line) => !/^\s*managed_root\s*=\s*"\.worktrees"\s*$/.test(line));
  const sectionIndex = lines.findIndex((line) => line.trim() === "[worktree.worktrunk]");
  if (sectionIndex === -1) {
    const body = lines.join("\n").replace(/\n*$/, "");
    const separator = body.length > 0 ? "\n\n" : "";
    return `${body}${separator}[worktree.worktrunk]\nmanaged_root = "~/.worktrees"\n`;
  }
  const nextSectionIndex = lines.findIndex(
    (line, index) => index > sectionIndex && /^\s*\[/.test(line),
  );
  const endIndex = nextSectionIndex === -1 ? lines.length : nextSectionIndex;
  const hasManagedRoot = lines
    .slice(sectionIndex + 1, endIndex)
    .some((line) => /^\s*managed_root\s*=/.test(line));
  if (!hasManagedRoot) {
    lines.splice(endIndex, 0, 'managed_root = "~/.worktrees"');
  }
  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

function managedRoots(options) {
  const roots = [join(repoRoot, ".worktrees")];
  if (options.allHomeWorktrees) {
    roots.push(join(home, ".worktrees"));
  } else {
    roots.push(join(home, ".worktrees", options.projectId));
  }
  return roots.map((root) => resolve(root));
}

function listGitWorktrees() {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return [];
  }
  const worktrees = [];
  let current;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current !== undefined) {
        worktrees.push(current);
      }
      current = { path: line.slice("worktree ".length), branch: undefined };
    } else if (line.startsWith("branch ") && current !== undefined) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current !== undefined) {
    worktrees.push(current);
  }
  return worktrees.filter((worktree) => resolve(worktree.path) !== repoRoot);
}

function worktreeStatus(path) {
  const result = spawnSync("git", ["-C", path, "status", "--short"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

export function isUnder(path, root) {
  const resolvedPath = resolve(path);
  const rel = relative(resolve(root), resolvedPath);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function spawnChecked(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed\n${result.stdout}\n${result.stderr}`);
  }
}

function printPlan(title, actions, dryRun) {
  process.stdout.write(`${title}: ${dryRun ? "dry run" : "running"}\n`);
  if (actions.length === 0) {
    process.stdout.write("  nothing to do\n");
    return;
  }
  for (const action of actions) {
    process.stdout.write(`  ${dryRun ? "would " : ""}${action.label}\n`);
  }
}

function printResetHelp() {
  process.stdout.write(`Usage: pnpm agent:reset [-- --yes]

Runs agent cleanup, then resets managed station worktree state. Dry-run by default.

Options:
  --run, --yes            perform reset
  --dry-run               print actions only
  --force-worktrees       remove dirty managed worktrees with git worktree remove --force
  --project-id <id>       home managed namespace to reset, default: station
  --all-home-worktrees    reset all ~/.worktrees namespaces
  --state                 also remove ~/.local/state/station
  --fix-config            remove profile = "default", remove project .worktrees override, add global ~/.worktrees
  --verbose               reserved for noisier future output
`);
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}
