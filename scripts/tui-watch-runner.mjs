#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, watch } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const restartDebounceMs = 500;
const restartExtensions = new Set([".js", ".json", ".mjs"]);
export const mouseReportingDisableSequence =
  "\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runWatchRunner(process.argv.slice(2));
}

export function runWatchRunner(argv, env = process.env) {
  const [entry, ...entryArgs] = argv;
  if (entry === undefined) {
    process.stderr.write("Usage: tui-watch-runner <entry> [...args]\n");
    process.exitCode = 1;
    return;
  }

  const watchRoots = watchRootsFromEnv(env);
  const watchers = watchRoots.flatMap((root) => watchTree(root, () => scheduleRestart(root)));
  let child = launchChild({ clear: false });
  let restartTimer;
  let restartPending = false;
  let shuttingDown = false;

  const closeWatchers = () => {
    for (const watcher of watchers) {
      watcher.close();
    }
  };

  function scheduleRestart(root) {
    if (shuttingDown) return;
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
    }
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      restartPending = true;
      process.stderr.write(`Restarting after rebuild in ${relative(repoRoot, root) || root}\n`);
      if (child === undefined) {
        restartPending = false;
        child = launchChild({ clear: true });
        return;
      }
      child.kill("SIGTERM");
    }, restartDebounceMs);
  }

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
    }
    disableMouseReporting();
    closeWatchers();
    child?.kill(signal);
    process.exitCode = 1;
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  function handleChildExit(code, signal) {
    child = undefined;
    disableMouseReporting();
    if (shuttingDown) {
      return;
    }
    if (restartPending) {
      restartPending = false;
      child = launchChild({ clear: true });
      return;
    }
    if (signal !== null || code !== 0) {
      process.stderr.write(
        `Failed running ${shellCommand([entry, ...entryArgs])}. Waiting for file changes before restarting...\n`,
      );
      return;
    }
    process.stderr.write(
      `Completed ${shellCommand([entry, ...entryArgs])}. Waiting for file changes before restarting...\n`,
    );
  }

  function launchChild(options) {
    if (options.clear) {
      clearTerminal();
    }
    const next = startChild(entry, entryArgs, env);
    next.on("exit", handleChildExit);
    return next;
  }
}

export function shouldRestartForPath(path) {
  return path === undefined || restartExtensions.has(extname(path));
}

export function defaultWatchRoots() {
  return [
    join(repoRoot, "apps/cli/dist"),
    join(repoRoot, "packages/contracts/dist"),
    join(repoRoot, "packages/protocol/dist"),
    join(repoRoot, "packages/runtime/dist"),
  ].filter((path) => existsSync(path));
}

function watchRootsFromEnv(env) {
  const configured = env.STATION_TUI_WATCH_ROOTS;
  if (configured === undefined || configured.length === 0) {
    return defaultWatchRoots();
  }
  return configured
    .split(":")
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

function watchTree(root, onChange) {
  if (!existsSync(root)) {
    return [];
  }
  return collectDirectories(root).map((directory) => {
    const watcher = watch(directory, (event, filename) => {
      if (event !== "change" && event !== "rename") {
        return;
      }
      const path = filename === null ? undefined : join(directory, filename.toString());
      if (!shouldRestartForPath(path)) {
        return;
      }
      onChange();
    });
    watcher.on("error", (error) => {
      process.stderr.write(`${formatError(error)}\n`);
    });
    return watcher;
  });
}

function collectDirectories(root) {
  const directories = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      directories.push(...collectDirectories(join(root, entry.name)));
    }
  }
  return directories;
}

function startChild(entry, args, env) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  child.on("error", (error) => {
    process.stderr.write(`${formatError(error)}\n`);
  });
  return child;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function clearTerminal() {
  if (process.stdout.isTTY) {
    process.stdout.write("\u001B[2J\u001B[3J\u001B[H");
  }
}

function disableMouseReporting() {
  if (process.stdout.isTTY) {
    process.stdout.write(mouseReportingDisableSequence);
  }
}

function shellCommand(parts) {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
