#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const home = homedir();

if (isMain()) {
  const options = parseCleanupArgs(process.argv.slice(2));
  await cleanupRuntime(options);
}

export function parseCleanupArgs(args) {
  const options = {
    dryRun: true,
    localObserver: true,
    realE2e: true,
    tmux: true,
    verbose: false,
  };

  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--run" || arg === "--yes") {
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-local-observer") {
      options.localObserver = false;
    } else if (arg === "--no-real-e2e") {
      options.realE2e = false;
    } else if (arg === "--no-tmux") {
      options.tmux = false;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "-h" || arg === "--help") {
      printCleanupHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown cleanup option: ${arg}`);
    }
  }

  return options;
}

export async function cleanupRuntime(options) {
  const actions = [];
  if (options.tmux) {
    actions.push(...tmuxCleanupActions());
  }
  if (options.localObserver || options.realE2e) {
    actions.push(...processCleanupActions(options));
  }

  printPlan("agent cleanup", actions, options.dryRun);
  for (const action of actions) {
    if (options.dryRun) {
      continue;
    }
    await action.run();
  }
  return actions;
}

function tmuxCleanupActions() {
  return listTmuxSessions()
    .filter((session) => session === "station" || session.startsWith("station-real-"))
    .map((session) => ({
      label: `kill tmux session ${session}`,
      run: async () => {
        spawnSync("tmux", ["kill-session", "-t", session], {
          cwd: repoRoot,
          stdio: "ignore",
        });
      },
    }));
}

function processCleanupActions(options) {
  return listProcesses()
    .filter((processInfo) => processInfo.pid !== process.pid && processInfo.pid !== process.ppid)
    .filter((processInfo) => {
      if (options.localObserver && isLocalObserver(processInfo.command)) {
        return true;
      }
      return options.realE2e && isRealE2eProcess(processInfo.command);
    })
    .map((processInfo) => ({
      label: `kill pid ${processInfo.pid} ${summarizeCommand(processInfo.command)}`,
      run: async () => {
        await killProcess(processInfo.pid);
      },
    }));
}

function listTmuxSessions() {
  const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function listProcesses() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,comm=,command="], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (match === null) {
        return undefined;
      }
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        commandName: match[3],
        command: match[4],
      };
    })
    .filter((value) => value !== undefined);
}

function isLocalObserver(command) {
  return (
    command.includes("/apps/cli/dist/observerMain.js") &&
    command.includes(`${home}/.local/state/station/run/observer.sock`)
  );
}

function isRealE2eProcess(command) {
  return command.includes("station-real-e2e-") || command.includes("station-real-");
}

async function killProcess(pid) {
  signalProcess(pid, "SIGTERM");
  await sleep(100);
  if (processExists(pid)) {
    signalProcess(pid, "SIGKILL");
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone is a successful cleanup outcome.
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

function summarizeCommand(command) {
  return command.length > 120 ? `${command.slice(0, 117)}...` : command;
}

function printCleanupHelp() {
  process.stdout.write(`Usage: pnpm agent:cleanup [-- --run]

Stops stale local station runtime debris. Dry-run by default.

Options:
  --run, --yes           perform cleanup
  --dry-run              print actions only
  --no-local-observer    do not stop the local station observer
  --no-real-e2e          do not stop temp real-e2e processes
  --no-tmux              do not kill station tmux sessions
  --verbose              reserved for noisier future output
`);
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}
