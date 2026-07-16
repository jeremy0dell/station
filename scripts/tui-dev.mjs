#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  const runtime = await prepareTuiDevRuntime({ argv, env });
  const devSessionName = runtime.env.STATION_TUI_SESSION_NAME ?? defaultDevSessionName;
  const devTuiCommand =
    runtime.env.STATION_TUI_COMMAND ??
    shellCommand([
      "env",
      ...devCommandEnvAssignments(runtime),
      process.execPath,
      tuiWatchRunner,
      cliEntry,
    ]);
  const devOwner = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const registeredDevTuiCommand =
    runtime.env.STATION_TUI_REGISTERED_COMMAND ??
    appendShellArgs(devTuiCommand, [
      ...globalOptionsFromArgs(runtime.argv),
      "tui",
      "--popup",
      "--persistent",
    ]);
  const runDirectTui = shouldRunDirectTui(runtime.argv, runtime.env);
  const keepAliveAfterLauncherExit = shouldKeepAliveAfterLauncherExit(runtime.argv, runtime.env);

  if (keepAliveAfterLauncherExit) {
    await guardAgainstForeignDevPopup({
      currentRoot: repoRoot,
      env: runtime.env,
    });
  }

  const logPath = join(repoRoot, ".turbo/tui-dev-build.log");
  await mkdir(dirname(logPath), { recursive: true });

  const initialBuild = spawnSync(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "build:identity",
      "--filter=@station/cli",
      "--output-logs=errors-only",
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: runtime.env,
    },
  );
  if (initialBuild.status !== 0) {
    process.exit(initialBuild.status ?? 1);
  }
  if (runtime.generated) {
    installTuiDevHooks(runtime);
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
      "build:identity",
      "--filter=@station/cli",
      "--ui=stream",
      "--output-logs=errors-only",
      "--continue=always",
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", logFd, logFd],
      env: runtime.env,
    },
  );

  const childEnv = {
    ...runtime.env,
    STATION_TUI_DEV: "1",
    STATION_TUI_COMMAND: devTuiCommand,
    STATION_TUI_DEV_OWNER: devOwner,
    STATION_TUI_SESSION_NAME: devSessionName,
  };
  const nodeArgs = runDirectTui
    ? [tuiWatchRunner, cliEntry, ...runtime.argv]
    : [cliEntry, ...runtime.argv];
  if (keepAliveAfterLauncherExit) {
    registerDevPopupPreference({
      env: runtime.env,
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
    clearDevPopupPreference({ env: runtime.env, owner: devOwner });
    cleanupDevUiSession(devSessionName, runtime.env, defaultDevSessionName);
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
    clearDevPopupPreference({ env: runtime.env, owner: devOwner });
    cleanupDevUiSession(devSessionName, runtime.env, defaultDevSessionName);
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
      clearDevPopupPreference({ env: runtime.env, owner: devOwner });
      cleanupDevUiSession(devSessionName, runtime.env, defaultDevSessionName);
    }
    closeLog();
    if (signal !== null) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 0;
  });
}

export async function prepareTuiDevRuntime({ argv = [], env = process.env, root = repoRoot } = {}) {
  const configFromArgs = configPathFromArgs(argv);
  if (configFromArgs !== undefined) {
    return {
      argv,
      env: envForExplicitConfig({ env, configPath: configFromArgs, root }),
      configPath: configFromArgs,
      generated: false,
    };
  }

  const configFromEnv = env.STATION_CONFIG_PATH?.trim();
  if (configFromEnv !== undefined && configFromEnv.length > 0) {
    return {
      argv: ["--config", configFromEnv, ...argv],
      env: envForExplicitConfig({ env, configPath: configFromEnv, root }),
      configPath: configFromEnv,
      generated: false,
    };
  }

  const generated = await writeTuiDevConfig({ env, root });
  const hookEnv = await prepareTuiDevHookEnv({
    env,
    checkoutRoot: root,
    stateRoot: generated.devRoot,
  });
  return {
    argv: ["--config", generated.configPath, ...argv],
    env: {
      ...env,
      ...hookEnv,
      STATION_CONFIG_PATH: generated.configPath,
      STATION_OBSERVER_SOCKET_PATH: generated.socketPath,
    },
    configPath: generated.configPath,
    generated: true,
  };
}

export async function writeTuiDevConfig({
  env = process.env,
  root = repoRoot,
  readSource = readFile,
  writeTarget = writeFile,
  makeDir = mkdir,
} = {}) {
  const devRoot = join(root, ".dev-state", "tui-dev");
  const stateDir = join(devRoot, "observer");
  const socketPath = tuiDevObserverSocketPath(root);
  const configPath = join(devRoot, "config.toml");
  const sourcePath = join(env.HOME ?? homedir(), ".config", "station", "config.toml");

  let source;
  try {
    source = await readSource(sourcePath, "utf8");
  } catch {
    source = fallbackConfigSource();
  }

  const config = withObserverPaths(source, { socketPath, stateDir });
  await makeDir(stateDir, { recursive: true });
  await makeDir(dirname(socketPath), { recursive: true });
  await writeTarget(configPath, config, "utf8");
  return { configPath, socketPath, stateDir, devRoot };
}

export function configPathFromArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--config") {
      continue;
    }
    const value = argv[index + 1];
    return value === undefined || value.startsWith("--") ? undefined : value;
  }
  return undefined;
}

export function withObserverPaths(source, paths) {
  let next = ensureTomlSection(source.trimEnd(), "observer");
  next = setTomlStringKey(next, "observer", "socket_path", paths.socketPath);
  next = setTomlStringKey(next, "observer", "state_dir", paths.stateDir);
  next = setTomlStringKey(next, "defaults", "terminal", "noop-terminal");
  next = setTomlBooleanKey(next, "feature_flags", "station_persistent_agents", true);
  next = setTomlBooleanKey(next, "harness.codex", "install_hooks", true);
  next = setTomlBooleanKey(next, "harness.claude", "install_hooks", true);
  next = setTomlBooleanKey(next, "harness.cursor", "install_hooks", true);
  next = setTomlBooleanKey(next, "harness.opencode", "install_hooks", true);
  return `${next.trimEnd()}\n`;
}

export async function prepareTuiDevHookEnv({
  env = process.env,
  checkoutRoot = repoRoot,
  stateRoot = join(repoRoot, ".dev-state", "tui-dev"),
} = {}) {
  const homes = tuiDevProviderHomeEnv(stateRoot);
  await mkdir(homes.CODEX_HOME, { recursive: true });
  await mkdir(homes.CLAUDE_CONFIG_DIR, { recursive: true });
  await mkdir(homes.STATION_CURSOR_HOME, { recursive: true });
  await mkdir(homes.OPENCODE_CONFIG_DIR, { recursive: true });

  const home = env.HOME ?? homedir();
  await replaceSymlinkIfPresent(
    join(home, ".codex", "auth.json"),
    join(homes.CODEX_HOME, "auth.json"),
  );
  await copyFileIfMissing(
    join(home, ".codex", "config.toml"),
    join(homes.CODEX_HOME, "config.toml"),
  );
  await seedCursorHome(home, homes.STATION_CURSOR_HOME);

  return {
    PATH: `${checkoutRoot}/bin${
      env.PATH === undefined || env.PATH.length === 0 ? "" : `:${env.PATH}`
    }`,
    ...homes,
  };
}

function envForExplicitConfig({ env, configPath, root }) {
  const next = { ...env, STATION_CONFIG_PATH: configPath };
  delete next.STATION_OBSERVER_SOCKET_PATH;

  const generatedHomes = tuiDevProviderHomeEnv(join(root, ".dev-state", "tui-dev"));
  for (const [name, value] of Object.entries(generatedHomes)) {
    if (next[name] === value) {
      delete next[name];
    }
  }
  return next;
}

function tuiDevProviderHomeEnv(stateRoot) {
  return {
    CODEX_HOME: join(stateRoot, "codex-home"),
    CLAUDE_CONFIG_DIR: join(stateRoot, "claude-home"),
    STATION_CURSOR_HOME: join(stateRoot, "cursor-home"),
    OPENCODE_CONFIG_DIR: join(stateRoot, "opencode-config"),
  };
}

export function installTuiDevHooks(runtime, runCommand = spawnSync) {
  for (const harness of ["codex", "claude", "cursor", "opencode"]) {
    const result = runCommand(
      process.execPath,
      [cliEntry, "--config", runtime.configPath, "hooks", "install", harness, "--yes"],
      {
        cwd: repoRoot,
        env: runtime.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if ((result.status ?? 1) === 0) {
      continue;
    }
    const detail = [result.stderr, result.stdout]
      .filter((text) => typeof text === "string" && text.trim().length > 0)
      .map((text) => text.trim())
      .join("\n");
    process.stderr.write(
      `warning: failed to install ${harness} hooks for isolated dev TUI${
        detail.length === 0 ? ".\n" : `:\n${detail}\n`
      }`,
    );
  }
}

function devCommandEnvAssignments(runtime) {
  const assignments = [["STATION_TUI_DEV", "1"]];
  for (const name of [
    "STATION_CONFIG_PATH",
    "STATION_OBSERVER_SOCKET_PATH",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "STATION_CURSOR_HOME",
    "OPENCODE_CONFIG_DIR",
    "PATH",
  ]) {
    const value = runtime.env[name];
    if (value !== undefined && value.length > 0) {
      assignments.push([name, value]);
    }
  }
  return assignments.map(([name, value]) => `${name}=${value}`);
}

async function replaceSymlinkIfPresent(source, target, type) {
  try {
    await lstat(source);
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await symlink(source, target, type);
  } catch {
    // Missing identity/auth files are fine; providers will prompt or use local config.
  }
}

async function copyFileIfMissing(source, target) {
  try {
    await readFile(target, "utf8");
    return;
  } catch {
    // Continue and copy from the real config if it exists.
  }

  try {
    await copyFile(source, target);
  } catch {
    // A missing real config is acceptable for fresh machines and tests.
  }
}

async function seedCursorHome(home, cursorHome) {
  await replaceSymlinkIfPresent(join(home, ".gitconfig"), join(cursorHome, ".gitconfig"));
  await replaceSymlinkIfPresent(
    join(home, ".git-credentials"),
    join(cursorHome, ".git-credentials"),
  );
  await replaceSymlinkIfPresent(join(home, ".ssh"), join(cursorHome, ".ssh"), "dir");
  await replaceSymlinkIfPresent(
    join(home, ".config", "git"),
    join(cursorHome, ".config", "git"),
    "dir",
  );
}

function fallbackConfigSource() {
  return [
    "schema_version = 1",
    "projects = []",
    "",
    "[observer]",
    'socket_path = ""',
    'state_dir = ""',
    "",
    "[defaults]",
    'worktree_provider = "worktrunk"',
    'terminal = "tmux"',
    'harness = "codex"',
    'layout = "agent-shell"',
    "",
  ].join("\n");
}

function ensureTomlSection(source, section) {
  if (tomlSectionBounds(source, section) !== undefined) {
    return source;
  }
  const expanded = expandInlineTomlTableSection(source, section);
  if (tomlSectionBounds(expanded, section) !== undefined) {
    return expanded;
  }
  return `${expanded.trimEnd()}\n\n[${section}]\n`;
}

function setTomlStringKey(source, section, key, value) {
  return setTomlKey(source, section, key, JSON.stringify(value));
}

function setTomlBooleanKey(source, section, key, value) {
  return setTomlKey(source, section, key, value ? "true" : "false");
}

function setTomlKey(source, section, key, renderedValue) {
  const bounds = tomlSectionBounds(source, section);
  if (bounds === undefined) {
    return setTomlKey(ensureTomlSection(source, section), section, key, renderedValue);
  }

  const body = source.slice(bounds.headerEnd, bounds.bodyEnd);
  const keyPattern = new RegExp(`^([ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*).*$`, "m");
  const match = keyPattern.exec(body);
  if (match !== null) {
    const lineStart = bounds.headerEnd + match.index;
    const lineEnd = lineStart + match[0].length;
    return `${source.slice(0, lineStart)}${match[1]}${renderedValue}${source.slice(lineEnd)}`;
  }

  return `${source.slice(0, bounds.headerEnd)}\n${key} = ${renderedValue}${source.slice(
    bounds.headerEnd,
  )}`;
}

function tomlSectionBounds(source, section) {
  const sectionPattern = new RegExp(`^[ \\t]*\\[${escapeRegExp(section)}\\][ \\t]*(?:#.*)?$`, "m");
  const match = sectionPattern.exec(source);
  if (match === null) {
    return undefined;
  }

  const nextSectionPattern = /^[ \t]*\[.*\][ \t]*(?:#.*)?$/gm;
  nextSectionPattern.lastIndex = match.index + match[0].length;
  const next = nextSectionPattern.exec(source);
  return {
    headerEnd: match.index + match[0].length,
    bodyEnd: next?.index ?? source.length,
  };
}

function expandInlineTomlTableSection(source, section) {
  const separator = section.lastIndexOf(".");
  if (separator === -1) {
    return source;
  }

  const parentSection = section.slice(0, separator);
  const tableKey = section.slice(separator + 1);
  const parentBounds = tomlSectionBounds(source, parentSection);
  if (parentBounds === undefined) {
    return source;
  }

  const parentBody = source.slice(parentBounds.headerEnd, parentBounds.bodyEnd);
  const inlinePattern = new RegExp(
    `^([ \\t]*)${escapeRegExp(tableKey)}[ \\t]*=[ \\t]*\\{(.*)\\}[ \\t]*(?:#.*)?$`,
    "m",
  );
  const match = inlinePattern.exec(parentBody);
  if (match === null) {
    return source;
  }

  const entries = inlineTableBodyToTomlLines(match[2]);
  if (entries.length === 0) {
    return source;
  }

  const lineStart = parentBounds.headerEnd + match.index;
  const lineEnd = lineStart + match[0].length;
  const removeEnd = source[lineEnd] === "\n" ? lineEnd + 1 : lineEnd;
  const withoutInline = `${source.slice(0, lineStart)}${source.slice(removeEnd)}`;
  const insertionIndex = parentBounds.bodyEnd - (removeEnd - lineStart);
  return `${withoutInline.slice(0, insertionIndex).trimEnd()}\n\n[${section}]\n${entries.join(
    "\n",
  )}\n${withoutInline.slice(insertionIndex).replace(/^\n+/, "\n")}`;
}

function inlineTableBodyToTomlLines(body) {
  return splitTopLevelCommas(body)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const equals = findTopLevelEquals(part);
      if (equals === -1) {
        return undefined;
      }
      return `${part.slice(0, equals).trim()} = ${part.slice(equals + 1).trim()}`;
    })
    .filter((line) => line !== undefined);
}

function splitTopLevelCommas(source) {
  const parts = [];
  let start = 0;
  const state = { quote: undefined, escaped: false, squareDepth: 0, braceDepth: 0 };
  for (let index = 0; index < source.length; index += 1) {
    updateTomlInlineScannerState(state, source[index]);
    if (
      source[index] === "," &&
      state.quote === undefined &&
      state.squareDepth === 0 &&
      state.braceDepth === 0
    ) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function findTopLevelEquals(source) {
  const state = { quote: undefined, escaped: false, squareDepth: 0, braceDepth: 0 };
  for (let index = 0; index < source.length; index += 1) {
    if (
      source[index] === "=" &&
      state.quote === undefined &&
      state.squareDepth === 0 &&
      state.braceDepth === 0
    ) {
      return index;
    }
    updateTomlInlineScannerState(state, source[index]);
  }
  return -1;
}

function updateTomlInlineScannerState(state, char) {
  if (state.quote !== undefined) {
    if (state.quote === '"' && char === "\\" && !state.escaped) {
      state.escaped = true;
      return;
    }
    if (char === state.quote && !state.escaped) {
      state.quote = undefined;
    }
    state.escaped = false;
    return;
  }
  if (char === '"' || char === "'") {
    state.quote = char;
  } else if (char === "[") {
    state.squareDepth += 1;
  } else if (char === "]") {
    state.squareDepth = Math.max(0, state.squareDepth - 1);
  } else if (char === "{") {
    state.braceDepth += 1;
  } else if (char === "}") {
    state.braceDepth = Math.max(0, state.braceDepth - 1);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export function tuiDevObserverSocketPath(root) {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return join(tmpdir(), `stn-td-${hash}`, "observer.sock");
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
