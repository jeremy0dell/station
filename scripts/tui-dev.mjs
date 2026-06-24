#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(repoRoot, "apps/cli/dist/main.js");
const tuiWatchRunner = join(repoRoot, "scripts/tui-watch-runner.mjs");
const defaultDevSessionName = defaultDevSessionNameForRoot(repoRoot);
const devPopupOptionNames = {
  command: "@station_tui_dev_command",
  owner: "@station_tui_dev_owner",
  root: "@station_tui_dev_root",
  sessionName: "@station_tui_dev_session_name",
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runTuiDev();
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

export async function runTuiDev({ argv = process.argv.slice(2), env = process.env } = {}) {
  const devSessionName = env.STATION_TUI_SESSION_NAME ?? defaultDevSessionName;
  const devTuiCommand =
    env.STATION_TUI_COMMAND ??
    shellCommand(["env", "STATION_TUI_DEV=1", process.execPath, tuiWatchRunner, cliEntry]);
  const devOwner = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const registeredDevTuiCommand =
    env.STATION_TUI_REGISTERED_COMMAND ??
    appendShellArgs(devTuiCommand, [
      ...globalOptionsFromArgs(argv),
      "tui",
      "--popup",
      "--persistent",
    ]);
  const runDirectTui = shouldRunDirectTui(argv, env);
  const keepAliveAfterLauncherExit = shouldKeepAliveAfterLauncherExit(argv, env);

  if (keepAliveAfterLauncherExit) {
    await guardAgainstForeignDevPopup({
      currentRoot: repoRoot,
      env,
    });
  }

  const logPath = join(repoRoot, ".turbo/tui-dev-build.log");
  await mkdir(dirname(logPath), { recursive: true });

  const initialBuild = spawnSync(
    "pnpm",
    ["exec", "turbo", "run", "build", "--filter=@station/cli", "--output-logs=errors-only"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    },
  );
  if (initialBuild.status !== 0) {
    process.exit(initialBuild.status ?? 1);
  }

  const logFd = openSync(logPath, "a");
  let logOpen = true;
  const closeLog = () => {
    if (!logOpen) return;
    logOpen = false;
    closeSync(logFd);
  };

  writeSync(logFd, `\n--- dev ${new Date().toISOString()} ---\n`);
  const buildWatcher = spawn(
    "pnpm",
    [
      "exec",
      "turbo",
      "watch",
      "build",
      "--filter=@station/cli",
      "--ui=stream",
      "--output-logs=errors-only",
      "--continue=always",
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", logFd, logFd],
      env,
    },
  );

  const childEnv = {
    ...env,
    STATION_TUI_DEV: "1",
    STATION_TUI_COMMAND: devTuiCommand,
    STATION_TUI_DEV_OWNER: devOwner,
    STATION_TUI_SESSION_NAME: devSessionName,
  };
  const nodeArgs = runDirectTui ? [tuiWatchRunner, cliEntry, ...argv] : [cliEntry, ...argv];
  if (keepAliveAfterLauncherExit) {
    registerDevPopupPreference({
      env,
      owner: devOwner,
      root: repoRoot,
      sessionName: devSessionName,
      tuiCommand: registeredDevTuiCommand,
    });
  }

  process.stderr.write(`dev build watcher: ${logPath}\n`);
  const station = spawn(process.execPath, nodeArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: childEnv,
  });

  let exiting = false;
  let launcherExited = false;
  const shutdown = (signal) => {
    if (exiting) return;
    exiting = true;
    buildWatcher.kill(signal);
    if (!launcherExited) {
      station.kill(signal);
    }
    clearDevPopupPreference({ env, owner: devOwner });
    cleanupDevUiSession(devSessionName, env, defaultDevSessionName);
    if (launcherExited) {
      closeLog();
      process.exitCode = 1;
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  buildWatcher.on("exit", (code, signal) => {
    if (exiting) {
      return;
    }
    exiting = true;
    if (!launcherExited) {
      station.kill("SIGTERM");
    }
    clearDevPopupPreference({ env, owner: devOwner });
    cleanupDevUiSession(devSessionName, env, defaultDevSessionName);
    closeLog();
    process.exitCode = signal === null ? (code ?? 1) : 1;
  });

  station.on("exit", (code, signal) => {
    launcherExited = true;
    if (keepAliveAfterLauncherExit && code === 0 && signal === null && !exiting) {
      process.stderr.write(
        "dev popup launcher exited; build watcher remains active. Press Ctrl-C to stop.\n",
      );
      return;
    }
    if (!exiting) {
      exiting = true;
      buildWatcher.kill("SIGTERM");
      clearDevPopupPreference({ env, owner: devOwner });
      cleanupDevUiSession(devSessionName, env, defaultDevSessionName);
    }
    closeLog();
    if (signal !== null) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 0;
  });
}

export function commandFromArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

export function globalOptionsFromArgs(argv) {
  const options = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined) {
        break;
      }
      options.push(arg, value);
      index += 1;
      continue;
    }
    break;
  }
  return options;
}

export function shouldRunDirectTui(argv, env) {
  const command = commandFromArgs(argv);
  return command === "tui" || (command === undefined && !isInsideTmux(env));
}

export function shouldKeepAliveAfterLauncherExit(argv, env) {
  const command = commandFromArgs(argv);
  return !shouldRunDirectTui(argv, env) && (command === undefined || command === "popup");
}

export function isInsideTmux(env) {
  const tmux = env.TMUX;
  return tmux !== undefined && tmux.length > 0;
}

export function defaultDevSessionNameForRoot(root) {
  const slug = basename(root)
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `_station-ui-dev-${slug.length === 0 ? "checkout" : slug}-${hash}`;
}

export function parseDevPopupOwnerPid(owner) {
  const rawPid = owner?.split(":", 1)[0];
  if (rawPid === undefined || rawPid.length === 0 || /[^0-9]/.test(rawPid)) {
    return undefined;
  }
  return Number(rawPid);
}

export function isForeignLiveDevPopup(input, isProcessAlive = processIsAlive) {
  if (input.root === undefined || input.root.length === 0 || input.root === input.currentRoot) {
    return false;
  }
  if (input.sessionName === undefined || input.sessionName.length === 0) {
    return false;
  }
  const pid = parseDevPopupOwnerPid(input.owner);
  return pid === undefined ? true : isProcessAlive(pid);
}

async function guardAgainstForeignDevPopup(options) {
  if (!isInsideTmux(options.env)) {
    return;
  }
  const registration = readDevPopupRegistration(options.env);
  if (
    !isForeignLiveDevPopup({
      currentRoot: options.currentRoot,
      root: registration.root,
      owner: registration.owner,
      sessionName: registration.sessionName,
    })
  ) {
    return;
  }

  const message = [
    "A station dev TUI is already registered from another checkout.",
    `root: ${registration.root ?? "(unknown)"}`,
    `session: ${registration.sessionName ?? "(unknown)"}`,
    `owner: ${registration.owner ?? "(unknown)"}`,
  ].join("\n");
  process.stderr.write(`${message}\n`);

  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "Refusing to start a second dev TUI non-interactively. Stop the other pnpm station:tui-dev process first.",
    );
  }

  const confirm = await promptYesNo("Stop that dev TUI and start this checkout instead? [y/N] ");
  if (!confirm) {
    throw new Error("Cancelled.");
  }
  stopRegisteredDevPopup(registration, options.env);
}

function readDevPopupRegistration(env) {
  const tmux = env.STATION_TMUX_BIN ?? "tmux";
  return {
    command: readTmuxGlobalOption(tmux, devPopupOptionNames.command, env),
    owner: readTmuxGlobalOption(tmux, devPopupOptionNames.owner, env),
    root: readTmuxGlobalOption(tmux, devPopupOptionNames.root, env),
    sessionName: readTmuxGlobalOption(tmux, devPopupOptionNames.sessionName, env),
  };
}

function readTmuxGlobalOption(tmux, name, env) {
  const result = spawnSync(tmux, ["show-options", "-gqv", name], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env,
  });
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
}

async function promptYesNo(question) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await readline.question(question);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    readline.close();
  }
}

function stopRegisteredDevPopup(registration, env) {
  const tmux = env.STATION_TMUX_BIN ?? "tmux";
  const pid = parseDevPopupOwnerPid(registration.owner);
  if (pid !== undefined) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The owner may have exited between the prompt and confirmation.
    }
  }
  if (registration.sessionName !== undefined) {
    spawnSync(tmux, ["kill-session", "-t", registration.sessionName], {
      cwd: repoRoot,
      stdio: "ignore",
      env,
    });
  }
  for (const name of Object.values(devPopupOptionNames)) {
    spawnSync(tmux, ["set-option", "-gq", "-u", name], {
      cwd: repoRoot,
      stdio: "ignore",
      env,
    });
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function registerDevPopupPreference(options) {
  if (!isInsideTmux(options.env)) {
    return;
  }
  const tmux = options.env.STATION_TMUX_BIN ?? "tmux";
  const values = [
    [devPopupOptionNames.command, options.tuiCommand],
    [devPopupOptionNames.owner, options.owner],
    [devPopupOptionNames.root, options.root],
    [devPopupOptionNames.sessionName, options.sessionName],
  ];
  for (const [name, value] of values) {
    spawnSync(tmux, ["set-option", "-gq", name, value], {
      cwd: repoRoot,
      stdio: "ignore",
      env: options.env,
    });
  }
}

function clearDevPopupPreference(options) {
  if (!isInsideTmux(options.env)) {
    return;
  }
  const tmux = options.env.STATION_TMUX_BIN ?? "tmux";
  const currentOwner = spawnSync(tmux, ["show-options", "-gqv", devPopupOptionNames.owner], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: options.env,
  }).stdout.trim();
  if (currentOwner !== options.owner) {
    return;
  }
  for (const name of Object.values(devPopupOptionNames)) {
    spawnSync(tmux, ["set-option", "-gq", "-u", name], {
      cwd: repoRoot,
      stdio: "ignore",
      env: options.env,
    });
  }
}

function cleanupDevUiSession(devSessionName, env, ownedDefaultSessionName) {
  if (devSessionName !== ownedDefaultSessionName || !isInsideTmux(env)) {
    return;
  }
  spawnSync(env.STATION_TMUX_BIN ?? "tmux", ["kill-session", "-t", devSessionName], {
    cwd: repoRoot,
    stdio: "ignore",
    env,
  });
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shellCommand(parts) {
  return parts.map(shellQuote).join(" ");
}

function appendShellArgs(command, args) {
  if (args.length === 0) {
    return command;
  }
  return [command, ...args.map(shellQuote)].join(" ");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
