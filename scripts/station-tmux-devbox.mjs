#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const checkoutKey = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
const privateRoot = join("/tmp", `stn-dbx-${checkoutKey}`);
const manifestPath = join(privateRoot, "manifest.json");
const cliPath = join(repoRoot, "apps", "cli", "dist", "main.js");
const stationDir = join(repoRoot, "station");
const hostEntry = join(stationDir, "src", "host", "hostMain.ts");
const baseSession = "station-devbox";
const hiddenSession = "_station-ui";
const manifestKeys = [
  "schemaVersion",
  "checkoutRoot",
  "checkoutKey",
  "root",
  "createdAt",
  "status",
  "tmuxBinary",
  "tmuxLabel",
  "tmuxWrapper",
  "tmuxTmpDir",
  "tmuxSocketPath",
  "tmuxLogPath",
  "tmuxServerPid",
  "baseSession",
  "hiddenSession",
  "configPath",
  "homeDir",
  "xdgConfigDir",
  "xdgStateDir",
  "xdgDataDir",
  "runtimeDir",
  "stateDir",
  "tempDir",
  "projectRoot",
  "providerCodexHome",
  "providerClaudeHome",
  "providerCursorHome",
  "providerOpenCodeHome",
  "observerSocketPath",
  "hostSocketPath",
  "layoutPath",
  "binDir",
  "bareTmuxShimPath",
  "bareTmuxLogPath",
  "popupLauncherPath",
  "popupLogPath",
  "observerIdentity",
  "devOwnerPid",
  "devOwnerStartTime",
];
const lanePassthroughEnvironmentVariables = new Set([
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "COLORTERM",
  "FORCE_COLOR",
  "LANG",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TZ",
  "USER",
]);
const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const psPath = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";

const [rawCommand = "dev", ...commandArgs] = process.argv.slice(2);
const command =
  rawCommand === "-h" || rawCommand === "--help"
    ? "help"
    : rawCommand === "tmux"
      ? "dev"
      : rawCommand;

try {
  switch (command) {
    case "dev":
      await dev();
      break;
    case "start":
      await start();
      break;
    case "attach":
      attach();
      break;
    case "status":
      status();
      break;
    case "logs":
      logs(commandArgs);
      break;
    case "stop":
      await stop();
      break;
    case "reset":
      await reset(commandArgs);
      break;
    case "help":
      help();
      break;
    default:
      throw new Error(`Unknown station:devbox tmux command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
}

async function dev() {
  let manifest = await ensureLaneStarted();
  const currentStartTime = processStartTime(process.pid);
  if (currentStartTime === undefined) {
    throw new Error(`Could not verify the tmux devbox owner process ${process.pid}.`);
  }
  if (
    manifest.devOwnerPid !== null &&
    manifest.devOwnerPid !== process.pid &&
    manifest.devOwnerStartTime !== null &&
    processMatchesStart(manifest.devOwnerPid, manifest.devOwnerStartTime)
  ) {
    throw new Error(
      `The private tmux lane already has foreground owner ${manifest.devOwnerPid}. ` +
        `Stop it with: pnpm station:devbox tmux stop`,
    );
  }
  manifest = {
    ...manifest,
    devOwnerPid: process.pid,
    devOwnerStartTime: currentStartTime,
  };
  writeManifest(manifest);
  printOwnership(manifest, collectEvidence(manifest));
  log("");
  log("Foreground owner active. Ctrl-C, SIGHUP, SIGTERM, or `tmux stop` cleans this lane.");
  await waitAsForegroundOwner();
}

async function start() {
  const manifest = await ensureLaneStarted();
  printOwnership(manifest, collectEvidence(manifest));
}

function attach() {
  const manifest = requireRunningManifest();
  if (!privateServerAlive(manifest) || !privateSessionExists(manifest, manifest.baseSession)) {
    throw staleLaneError(manifest);
  }
  const result = run(manifest.tmuxWrapper, ["attach-session", "-t", manifest.baseSession], {
    cwd: manifest.projectRoot,
    env: laneEnvironment(manifest),
    stdio: "inherit",
    check: false,
    timeoutMs: undefined,
  });
  process.exitCode = result.status;
}

function status() {
  if (!existsSync(privateRoot)) {
    log(`Station private tmux devbox: stopped (${privateRoot} is absent)`);
    return;
  }
  const manifest = readManifest();
  printOwnership(manifest, collectEvidence(manifest));
}

function logs(args) {
  const unknown = args.find((arg) => !["--", "-f", "--follow"].includes(arg));
  if (unknown !== undefined) {
    throw new Error(`Unknown station:devbox tmux logs option: ${unknown}`);
  }
  const manifest = requireManifest();
  const follow = args.includes("-f") || args.includes("--follow");
  const files = [
    manifest.tmuxLogPath,
    manifest.popupLogPath,
    join(manifest.stateDir, "logs", "observer-boot.log"),
    join(manifest.stateDir, "logs", "observer.jsonl"),
    join(manifest.stateDir, "logs", "cli.jsonl"),
    join(manifest.stateDir, "logs", "tui.jsonl"),
    join(manifest.stateDir, "logs", "station-host.jsonl"),
  ].filter(existsSync);
  if (files.length === 0) {
    log(`No private tmux devbox logs exist under ${manifest.root}.`);
    return;
  }
  log("Private tmux devbox logs:");
  for (const file of files) {
    log(`  ${file}`);
  }
  log("");
  const tail = requireExecutable("tail");
  const result = run(tail, follow ? ["-f", ...files] : ["-n", "80", ...files], {
    stdio: "inherit",
    check: false,
    timeoutMs: undefined,
  });
  process.exitCode = result.status;
}

async function stop() {
  if (!existsSync(privateRoot)) {
    log(`Station private tmux devbox already stopped (${privateRoot} is absent).`);
    return;
  }
  const manifest = readManifest();
  await cleanupLane(manifest);
  log(`Stopped the private tmux lane and removed ${privateRoot}.`);
}

async function reset(args) {
  if (!args.some((arg) => arg === "--yes" || arg === "-y")) {
    throw new Error(
      "Refusing to reset without --yes.\n\n" + "  pnpm station:devbox tmux reset --yes",
    );
  }
  if (!existsSync(privateRoot)) {
    log(`Station private tmux devbox already reset (${privateRoot} is absent).`);
    return;
  }
  const manifest = readManifest();
  await cleanupLane(manifest);
  log(`Reset the verified private tmux lane at ${privateRoot}.`);
}

function help() {
  process.stdout.write(
    [
      "Usage: pnpm station:devbox tmux [dev|start|attach|status|logs|stop|reset|help]",
      "",
      "  dev              (default) start/reuse the HMR lane and remain its cleanup owner",
      "  start            start/reuse the HMR lane and return",
      "  attach           attach an ordinary client to the private base session",
      "  status           inspect only the private manifest/server/socket/process evidence",
      "  logs [--follow]  show wrapper, popup, Observer, CLI, TUI, and Host logs",
      "  stop             stop recorded private resources and remove the disposable root",
      "  reset --yes      recover a verified partial/stale lane and remove its root",
      "  help             show this nested grammar",
      "",
      "Inside the attached client, press Ctrl-b Space to open or toggle Station.",
      "Package/CLI/Observer changes require: stop → pnpm build → tmux dev.",
      "",
    ].join("\n"),
  );
}

async function ensureLaneStarted() {
  const prerequisites = resolvePrerequisites();
  if (existsSync(privateRoot)) {
    let manifest = readManifest();
    if (!privateServerAlive(manifest) || !privateSessionExists(manifest, manifest.baseSession)) {
      throw staleLaneError(manifest);
    }
    if (!observerIdentityAlive(manifest, manifest.observerIdentity)) {
      startObserver(manifest);
      manifest = {
        ...manifest,
        observerIdentity: readObserverIdentity(manifest.observerSocketPath),
      };
      writeManifest(manifest);
    }
    return manifest;
  }

  mkdirSync(privateRoot, { mode: 0o700 });
  chmodSync(privateRoot, 0o700);
  let manifest = createManifest(prerequisites);
  writeManifest(manifest);
  try {
    createDisposableEnvironment(manifest, prerequisites);
    run(prerequisites.bun, ["run", "--silent", "--cwd", stationDir, "link:station"], {
      cwd: repoRoot,
      env: laneEnvironment(manifest),
    });
    startObserver(manifest);
    manifest = {
      ...manifest,
      observerIdentity: readObserverIdentity(manifest.observerSocketPath),
    };
    writeManifest(manifest);

    // A non-login shell preserves the private PATH so bare tmux cannot bypass the failing shim.
    run(
      manifest.tmuxWrapper,
      ["new-session", "-d", "-s", manifest.baseSession, "-c", manifest.projectRoot, "/bin/sh"],
      {
        cwd: manifest.projectRoot,
        env: laneEnvironment(manifest),
      },
    );
    // Tmux defaults import SSH agent variables from later clients into the server.
    run(manifest.tmuxWrapper, ["set-option", "-g", "update-environment", ""], {
      cwd: manifest.projectRoot,
      env: laneEnvironment(manifest),
    });
    manifest = {
      ...manifest,
      tmuxServerPid: positiveInteger(
        privateTmuxOutput(manifest, ["display-message", "-p", "#{pid}"]),
        "private tmux server pid",
      ),
    };
    writeManifest(manifest);
    run(
      manifest.tmuxWrapper,
      ["set-environment", "-g", "STATION_DASHBOARD_COMMAND", dashboardCommand(prerequisites.bun)],
      {
        cwd: manifest.projectRoot,
        env: laneEnvironment(manifest),
      },
    );
    const popupCommand = `${shellQuote(manifest.popupLauncherPath)} '#{client_name}'`;
    run(manifest.tmuxWrapper, ["bind-key", "Space", "run-shell", "-b", popupCommand], {
      cwd: manifest.projectRoot,
      env: laneEnvironment(manifest),
    });
    manifest = { ...manifest, status: "running" };
    writeManifest(manifest);
    return manifest;
  } catch (startupError) {
    try {
      await cleanupLane(manifest);
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        `Private tmux devbox startup failed and cleanup retained ${privateRoot} as evidence.`,
      );
    }
    throw startupError;
  }
}

function resolvePrerequisites() {
  const tmux = requireExecutable(
    process.env.STATION_TMUX_DEVBOX_TMUX_BIN ?? process.env.STATION_REAL_TMUX_BIN ?? "tmux",
  );
  const bun = requireExecutable(process.env.STATION_BUN ?? "bun");
  const git = requireExecutable("git");
  const lsof = requireExecutable("lsof");
  run(tmux, ["-V"]);
  if (!existsSync(cliPath)) {
    throw new Error(`Built Station CLI missing at ${cliPath}. Run pnpm build.`);
  }
  if (!existsSync(join(stationDir, "node_modules", "@opentui", "core", "package.json"))) {
    throw new Error(`Station Bun dependencies are missing. Run: cd ${stationDir} && bun install`);
  }
  return {
    node: process.execPath,
    bun,
    git,
    lsof,
    tmux: realpathSync(tmux),
  };
}

function createManifest(prerequisites) {
  const tmuxLabel = `stn-dbx-${checkoutKey}`;
  const tmuxTmpDir = join(privateRoot, "tmux");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return {
    schemaVersion: 1,
    checkoutRoot: repoRoot,
    checkoutKey,
    root: privateRoot,
    createdAt: new Date().toISOString(),
    status: "starting",
    tmuxBinary: prerequisites.tmux,
    tmuxLabel,
    tmuxWrapper: join(privateRoot, "tmux-wrapper"),
    tmuxTmpDir,
    tmuxSocketPath: join(tmuxTmpDir, `tmux-${uid}`, tmuxLabel),
    tmuxLogPath: join(privateRoot, "logs", "tmux-wrapper.log"),
    tmuxServerPid: null,
    baseSession,
    hiddenSession,
    configPath: join(privateRoot, "config.toml"),
    homeDir: join(privateRoot, "home"),
    xdgConfigDir: join(privateRoot, "xdg-config"),
    xdgStateDir: join(privateRoot, "xdg-state"),
    xdgDataDir: join(privateRoot, "xdg-data"),
    runtimeDir: join(privateRoot, "run"),
    stateDir: join(privateRoot, "state"),
    tempDir: join(privateRoot, "tmp"),
    projectRoot: join(privateRoot, "project"),
    providerCodexHome: join(privateRoot, "providers", "codex"),
    providerClaudeHome: join(privateRoot, "providers", "claude"),
    providerCursorHome: join(privateRoot, "providers", "cursor"),
    providerOpenCodeHome: join(privateRoot, "providers", "opencode"),
    observerSocketPath: join(privateRoot, "run", "observer.sock"),
    hostSocketPath: join(privateRoot, "run", "station-host.sock"),
    layoutPath: join(privateRoot, "state", "station", "layout.json"),
    binDir: join(privateRoot, "bin"),
    bareTmuxShimPath: join(privateRoot, "bin", "tmux"),
    bareTmuxLogPath: join(privateRoot, "logs", "bare-tmux.log"),
    popupLauncherPath: join(privateRoot, "popup"),
    popupLogPath: join(privateRoot, "logs", "popup.log"),
    observerIdentity: null,
    devOwnerPid: null,
    devOwnerStartTime: null,
  };
}

function createDisposableEnvironment(manifest, prerequisites) {
  for (const directory of [
    manifest.homeDir,
    manifest.xdgConfigDir,
    manifest.xdgStateDir,
    manifest.xdgDataDir,
    manifest.runtimeDir,
    manifest.stateDir,
    manifest.tempDir,
    manifest.projectRoot,
    manifest.providerCodexHome,
    manifest.providerClaudeHome,
    manifest.providerCursorHome,
    manifest.providerOpenCodeHome,
    manifest.binDir,
    manifest.tmuxTmpDir,
    dirname(manifest.tmuxLogPath),
    dirname(manifest.layoutPath),
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  writeManagedFile(manifest.configPath, renderConfig(manifest), 0o600);
  writeManagedFile(manifest.tmuxWrapper, renderTmuxWrapper(manifest), 0o700);
  writeManagedFile(manifest.bareTmuxShimPath, renderBareTmuxShim(manifest), 0o700);
  writeManagedFile(manifest.popupLauncherPath, renderPopupLauncher(manifest, prerequisites), 0o700);
  writeManagedFile(
    join(manifest.projectRoot, "README.md"),
    "# Station private tmux devbox\n",
    0o600,
  );

  const gitEnv = laneEnvironment(manifest, { GIT_CONFIG_NOSYSTEM: "1" });
  run(prerequisites.git, ["init", "-q", "--initial-branch=main"], {
    cwd: manifest.projectRoot,
    env: gitEnv,
  });
  run(prerequisites.git, ["config", "user.name", "Station Devbox"], {
    cwd: manifest.projectRoot,
    env: gitEnv,
  });
  run(prerequisites.git, ["config", "user.email", "station-devbox@example.invalid"], {
    cwd: manifest.projectRoot,
    env: gitEnv,
  });
  run(prerequisites.git, ["add", "README.md"], {
    cwd: manifest.projectRoot,
    env: gitEnv,
  });
  run(
    prerequisites.git,
    ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Initialize Station devbox"],
    {
      cwd: manifest.projectRoot,
      env: gitEnv,
    },
  );
}

function renderConfig(manifest) {
  return [
    "schema_version = 1",
    "",
    "[observer]",
    `socket_path = ${JSON.stringify(manifest.observerSocketPath)}`,
    `state_dir = ${JSON.stringify(manifest.stateDir)}`,
    "auto_start = false",
    "auto_start_from_hooks = false",
    "",
    "[defaults]",
    'worktree_provider = "noop-worktree"',
    'terminal = "tmux"',
    'harness = "noop-harness"',
    'layout = "agent-shell"',
    "",
    "[terminal.tmux]",
    `command = ${JSON.stringify(manifest.tmuxWrapper)}`,
    "",
    "[repository.github]",
    "enabled = false",
    "",
    "[harness.noop-harness]",
    "enabled = true",
    "install_hooks = false",
    "",
    "[[projects]]",
    'id = "station-tmux-devbox"',
    'label = "Station private tmux devbox"',
    `root = ${JSON.stringify(manifest.projectRoot)}`,
    "",
  ].join("\n");
}

function renderTmuxWrapper(manifest) {
  return [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    `tmux_bin=${shellQuote(manifest.tmuxBinary)}`,
    `tmux_label=${shellQuote(manifest.tmuxLabel)}`,
    `tmux_log=${shellQuote(manifest.tmuxLogPath)}`,
    `export TMUX_TMPDIR=${shellQuote(manifest.tmuxTmpDir)}`,
    'mkdir -p "$(dirname "$tmux_log")"',
    "rejected=",
    "parsing_global=1",
    'for arg in "$@"; do',
    '  if [ "$parsing_global" -eq 1 ]; then',
    '    case "$arg" in',
    '      -L|-L*|-S|-S*|-f|-f*) rejected="$arg" ;;',
    "      --) parsing_global=0 ;;",
    "      -*) ;;",
    "      *) parsing_global=0 ;;",
    "    esac",
    "  fi",
    "done",
    "tab=$(printf '\\t')",
    `record="$(date -u +%Y-%m-%dT%H:%M:%SZ)\${tab}pid=$$\${tab}\${tmux_bin}\${tab}-L\${tab}\${tmux_label}\${tab}-f\${tab}/dev/null"`,
    `for arg in "$@"; do record="\${record}\${tab}\${arg}"; done`,
    'printf "%s\\n" "$record" >> "$tmux_log"',
    'if [ -n "$rejected" ]; then',
    '  printf "private tmux wrapper rejects server/config override: %s\\n" "$rejected" >&2',
    "  exit 64",
    "fi",
    "unset TMUX",
    'exec "$tmux_bin" -L "$tmux_label" -f /dev/null "$@"',
    "",
  ].join("\n");
}

function renderBareTmuxShim(manifest) {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${shellQuote(manifest.bareTmuxLogPath)}`,
    'printf "bare tmux is disabled inside the Station private tmux devbox\\n" >&2',
    "exit 97",
    "",
  ].join("\n");
}

function renderPopupLauncher(manifest, prerequisites) {
  return [
    "#!/bin/sh",
    "set +e",
    "umask 077",
    `export HOME=${shellQuote(manifest.homeDir)}`,
    `export XDG_CONFIG_HOME=${shellQuote(manifest.xdgConfigDir)}`,
    `export XDG_STATE_HOME=${shellQuote(manifest.xdgStateDir)}`,
    `export XDG_DATA_HOME=${shellQuote(manifest.xdgDataDir)}`,
    `export XDG_RUNTIME_DIR=${shellQuote(manifest.runtimeDir)}`,
    `export TMPDIR=${shellQuote(manifest.tempDir)}`,
    `export CODEX_HOME=${shellQuote(manifest.providerCodexHome)}`,
    `export CLAUDE_CONFIG_DIR=${shellQuote(manifest.providerClaudeHome)}`,
    `export STATION_CURSOR_HOME=${shellQuote(manifest.providerCursorHome)}`,
    `export OPENCODE_CONFIG_DIR=${shellQuote(manifest.providerOpenCodeHome)}`,
    `export STATION_CONFIG_PATH=${shellQuote(manifest.configPath)}`,
    `export STATION_OBSERVER_SOCKET_PATH=${shellQuote(manifest.observerSocketPath)}`,
    `export STATION_HOST_SOCKET_PATH=${shellQuote(manifest.hostSocketPath)}`,
    `export STATION_LAYOUT_PATH=${shellQuote(manifest.layoutPath)}`,
    `export STATION_TMUX_BIN=${shellQuote(manifest.tmuxWrapper)}`,
    `export STATION_BUN=${shellQuote(prerequisites.bun)}`,
    `export STATION_HOST_ENTRY=${shellQuote(hostEntry)}`,
    `export TMUX_TMPDIR=${shellQuote(manifest.tmuxTmpDir)}`,
    `export PATH=${shellQuote(`${manifest.binDir}:${process.env.PATH ?? ""}`)}`,
    `export STATION_DASHBOARD_COMMAND=${shellQuote(dashboardCommand(prerequisites.bun))}`,
    "unset STATION_SOURCE STATION_SCENARIO STATION_TUI_COMMAND STATION_TUI_SESSION_NAME",
    `if [ -n "\${1:-}" ]; then export STATION_FOCUS_CLIENT_ID="$1"; else unset STATION_FOCUS_CLIENT_ID; fi`,
    `${shellQuote(prerequisites.node)} ${shellQuote(cliPath)} --config ${shellQuote(manifest.configPath)} popup >> ${shellQuote(manifest.popupLogPath)} 2>&1`,
    "status=$?",
    'case "$status" in 0|129) exit 0 ;; esac',
    `${shellQuote(manifest.tmuxWrapper)} display-message -d 3000 ` +
      `${shellQuote("Station popup failed; run pnpm station:devbox tmux logs")} ` +
      `>> ${shellQuote(manifest.popupLogPath)} 2>&1 || :`,
    "exit 0",
    "",
  ].join("\n");
}

function dashboardCommand(bun) {
  return (
    `cd ${shellQuote(stationDir)} && exec ${shellQuote(bun)} ` +
    `--hot --no-clear-screen ${shellQuote("src/dashboardRenderer/main.tsx")}`
  );
}

function startObserver(manifest) {
  const result = run(
    process.execPath,
    [cliPath, "--config", manifest.configPath, "observer", "start"],
    {
      cwd: manifest.projectRoot,
      env: laneEnvironment(manifest),
      check: false,
      timeoutMs: 30_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Private Observer startup failed (exit ${result.status}).\n${result.stderr || result.stdout}`,
    );
  }
}

function requireRunningManifest() {
  const manifest = requireManifest();
  if (manifest.status !== "running") {
    throw staleLaneError(manifest);
  }
  return manifest;
}

function requireManifest() {
  if (!existsSync(privateRoot)) {
    throw new Error("Private tmux devbox is not started. Run: pnpm station:devbox tmux dev");
  }
  return readManifest();
}

function readManifest() {
  validateRoot();
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Refusing to manage ${privateRoot}: its validated manifest is missing. Preserve it as evidence.`,
    );
  }
  const manifestStat = lstatSync(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    (manifestStat.mode & 0o077) !== 0
  ) {
    throw new Error(`Refusing unsafe private tmux manifest at ${manifestPath}.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Private tmux manifest is invalid JSON: ${manifestPath}`, { cause: error });
  }
  validateManifest(manifest);
  return manifest;
}

function validateRoot() {
  const rootStat = lstatSync(privateRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe private tmux root: ${privateRoot}`);
  }
  if ((rootStat.mode & 0o077) !== 0) {
    throw new Error(`Private tmux root must use mode 0700: ${privateRoot}`);
  }
  if (typeof process.getuid === "function" && rootStat.uid !== process.getuid()) {
    throw new Error(`Private tmux root is not owned by the current user: ${privateRoot}`);
  }
}

function validateManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Private tmux manifest must be an object: ${manifestPath}`);
  }
  const keys = Object.keys(manifest).sort();
  const expectedKeys = [...manifestKeys].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Private tmux manifest has an unsupported shape: ${manifestPath}`);
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.checkoutRoot !== repoRoot ||
    manifest.checkoutKey !== checkoutKey ||
    manifest.root !== privateRoot ||
    !["starting", "running"].includes(manifest.status)
  ) {
    throw new Error(`Private tmux manifest does not belong to this checkout: ${manifestPath}`);
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error(`Private tmux manifest has an invalid creation timestamp: ${manifestPath}`);
  }
  const expected = createManifest({
    tmux: manifest.tmuxBinary,
  });
  for (const key of manifestKeys) {
    if (
      [
        "createdAt",
        "status",
        "tmuxBinary",
        "tmuxServerPid",
        "observerIdentity",
        "devOwnerPid",
        "devOwnerStartTime",
      ].includes(key)
    ) {
      continue;
    }
    if (manifest[key] !== expected[key]) {
      throw new Error(`Private tmux manifest field ${key} is not checkout-scoped.`);
    }
  }
  if (!isAbsolute(manifest.tmuxBinary)) {
    throw new Error("Private tmux manifest must record an absolute tmux executable.");
  }
  if (
    !nullablePositiveInteger(manifest.tmuxServerPid) ||
    !nullablePositiveInteger(manifest.devOwnerPid)
  ) {
    throw new Error("Private tmux manifest contains an invalid recorded PID.");
  }
  if (
    manifest.devOwnerStartTime !== null &&
    (typeof manifest.devOwnerStartTime !== "string" || manifest.devOwnerStartTime.length === 0)
  ) {
    throw new Error("Private tmux manifest contains an invalid owner start time.");
  }
  if (manifest.observerIdentity !== null) {
    validateObserverIdentity(manifest.observerIdentity, manifest.observerSocketPath);
  }
  for (const key of manifestKeys.filter(
    (candidate) =>
      candidate.endsWith("Path") ||
      candidate.endsWith("Dir") ||
      candidate.endsWith("Home") ||
      candidate === "root" ||
      candidate === "projectRoot" ||
      candidate === "binDir",
  )) {
    if (key === "checkoutRoot") {
      continue;
    }
    const value = manifest[key];
    if (typeof value !== "string" || !pathInside(privateRoot, value)) {
      throw new Error(`Private tmux manifest path ${key} escapes ${privateRoot}.`);
    }
  }
}

function writeManifest(manifest) {
  validateManifest(manifest);
  const temporaryPath = join(privateRoot, `.manifest.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, manifestPath);
  chmodSync(manifestPath, 0o600);
}

function validateObserverIdentity(identity, socketPath) {
  const keys = Object.keys(identity).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(["osStartTime", "pid", "socketPath", "version"]) ||
    !Number.isInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.osStartTime !== "string" ||
    identity.osStartTime.length === 0 ||
    typeof identity.version !== "string" ||
    identity.version.length === 0 ||
    identity.socketPath !== socketPath
  ) {
    throw new Error(`Private Observer identity is invalid for ${socketPath}.`);
  }
}

function readObserverIdentity(socketPath) {
  const identityPath = `${socketPath}.pid`;
  if (!existsSync(identityPath)) {
    throw new Error(`Private Observer identity did not appear at ${identityPath}.`);
  }
  let identity;
  try {
    identity = JSON.parse(readFileSync(identityPath, "utf8"));
  } catch (error) {
    throw new Error(`Private Observer identity is invalid at ${identityPath}.`, { cause: error });
  }
  validateObserverIdentity(identity, socketPath);
  return identity;
}

function collectEvidence(manifest) {
  const serverAlive = privateServerAlive(manifest);
  const sessions = serverAlive
    ? privateTmuxOutput(
        manifest,
        ["list-sessions", "-F", "#{session_name}\t#{session_attached}"],
        false,
      )
    : "";
  const basePane = serverAlive
    ? privateTmuxOutput(
        manifest,
        ["list-panes", "-t", manifest.baseSession, "-F", "#{pane_id}\t#{pane_pid}"],
        false,
      )
    : "";
  const hiddenPane =
    serverAlive && privateSessionExists(manifest, manifest.hiddenSession)
      ? privateTmuxOutput(
          manifest,
          ["list-panes", "-t", manifest.hiddenSession, "-F", "#{pane_id}\t#{pane_pid}"],
          false,
        )
      : "";
  const nestedClients =
    serverAlive && privateSessionExists(manifest, manifest.hiddenSession)
      ? privateTmuxOutput(
          manifest,
          ["list-clients", "-t", manifest.hiddenSession, "-F", "#{client_name}\t#{client_pid}"],
          false,
        )
      : "";
  const records = processRecords();
  const hiddenPid = panePidFromEvidence(hiddenPane);
  const hiddenProcess =
    hiddenPid === undefined ? undefined : records.find((record) => record.pid === hiddenPid);
  const processTree =
    hiddenPid === undefined
      ? []
      : [
          ...(hiddenProcess === undefined ? [] : [hiddenProcess]),
          ...descendantRecords(records, hiddenPid),
        ];
  const cli = processTree.find(
    (record) =>
      record.command.includes(cliPath) &&
      record.command.includes("tui") &&
      record.command.includes("--popup") &&
      record.command.includes("--persistent"),
  );
  const renderer = processTree.find(
    (record) =>
      record.command.includes("bun") && record.command.includes("src/dashboardRenderer/main.tsx"),
  );
  const observer =
    manifest.observerIdentity === null ? undefined : processRecord(manifest.observerIdentity.pid);
  const host = findHostRecord(records, manifest);
  const server =
    manifest.tmuxServerPid === null ? undefined : processRecord(manifest.tmuxServerPid);
  const basePid = panePidFromEvidence(basePane);
  const baseDescendants = basePid === undefined ? [] : descendantRecords(records, basePid);
  const nestedPids = nestedClients
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const pid = Number(line.split("\t")[1]);
      return Number.isInteger(pid) && pid > 0 ? [pid] : [];
    });
  const runtimeRecords = [
    server,
    basePid === undefined ? undefined : processRecord(basePid),
    hiddenPid === undefined ? undefined : processRecord(hiddenPid),
    cli,
    renderer,
    observer,
    host,
    ...nestedPids.map(processRecord),
  ].filter((record) => record !== undefined);
  return {
    serverAlive,
    sessions,
    basePane,
    hiddenPane,
    nestedClients,
    cli,
    renderer,
    observer,
    host,
    baseDescendants,
    runtimeRecords,
  };
}

function printOwnership(manifest, evidence) {
  log(`Station private tmux devbox: ${evidence.serverAlive ? "running" : "stale"}`);
  log(`checkout:       ${manifest.checkoutRoot}`);
  log(`checkout key:   ${manifest.checkoutKey}`);
  log(`private root:   ${manifest.root}`);
  log(`tmux label:     ${manifest.tmuxLabel}`);
  log(`tmux binary:    ${manifest.tmuxBinary}`);
  log(`tmux wrapper:   ${manifest.tmuxWrapper}`);
  log("tmux config:    /dev/null");
  log(`tmux socket:    ${manifest.tmuxSocketPath}`);
  log(`config:         ${manifest.configPath}`);
  log(`state root:     ${manifest.stateDir}`);
  log(`Observer socket:${manifest.observerSocketPath}`);
  log(`Host socket:    ${manifest.hostSocketPath}`);
  log(`layout:         ${manifest.layoutPath}`);
  log(`base session:   ${manifest.baseSession}${formatPane(evidence.basePane)}`);
  log(
    `hidden session: ${evidence.hiddenPane.length === 0 ? `${manifest.hiddenSession} (not created until first popup)` : `${manifest.hiddenSession}${formatPane(evidence.hiddenPane)}`}`,
  );
  log(
    `Observer:       ${evidence.observer === undefined ? "not running" : `${evidence.observer.pid} ${evidence.observer.command}`}`,
  );
  log(
    `CLI parent:     ${evidence.cli === undefined ? "not created until first popup" : `${evidence.cli.pid} ${evidence.cli.command}`}`,
  );
  log(
    `Bun renderer:   ${evidence.renderer === undefined ? "not created until first popup" : `${evidence.renderer.pid} ${evidence.renderer.command}`}`,
  );
  log(
    `renderer IPC:   ${evidence.cli !== undefined && evidence.renderer !== undefined ? `${evidence.cli.pid} -> ${evidence.renderer.pid}` : "not established until first popup"}`,
  );
  log(
    `nested client:  ${evidence.nestedClients.length === 0 ? "not attached" : evidence.nestedClients.replaceAll("\n", ", ")}`,
  );
  log(
    `Station Host:   ${evidence.host === undefined ? "absent (expected for this read-only lane)" : `${evidence.host.pid} ${evidence.host.command}`}`,
  );
  log("");
  log("Open:");
  log("  pnpm station:devbox tmux attach");
  log("  then press Ctrl-b Space");
  log("Debug:");
  log("  pnpm station:devbox tmux status");
  log("  pnpm station:devbox tmux logs --follow");
  log("Stop:");
  log("  pnpm station:devbox tmux stop");
}

async function cleanupLane(manifest) {
  const failures = [];
  const evidence = collectEvidence(manifest);

  if (existsSync(manifest.tmuxWrapper)) {
    run(manifest.tmuxWrapper, ["kill-server"], {
      cwd: manifest.projectRoot,
      env: laneEnvironment(manifest),
      check: false,
      timeoutMs: 10_000,
    });
  }
  if (privateServerAlive(manifest)) {
    failures.push(new Error(`private tmux server ${manifest.tmuxLabel} survived kill-server`));
  }

  for (const record of evidence.baseDescendants) {
    try {
      await terminateRecordedPrivateProcess(record);
    } catch (error) {
      failures.push(error);
    }
  }

  if (existsSync(cliPath) && existsSync(manifest.configPath)) {
    run(
      process.execPath,
      [cliPath, "--config", manifest.configPath, "observer", "stop", "--timeout-ms", "5000"],
      {
        cwd: manifest.projectRoot,
        env: laneEnvironment(manifest),
        check: false,
        timeoutMs: 10_000,
      },
    );
  }

  try {
    await terminateObserver(manifest);
  } catch (error) {
    failures.push(error);
  }
  try {
    await terminateHost(manifest);
  } catch (error) {
    failures.push(error);
  }

  for (const record of evidence.runtimeRecords) {
    if (
      manifest.observerIdentity?.pid === record.pid ||
      evidence.host?.pid === record.pid ||
      record.pid === process.pid
    ) {
      continue;
    }
    if (!(await waitForRecordedProcessExit(record, 5_000))) {
      failures.push(
        new Error(`recorded private process ${record.pid} did not exit: ${record.command}`),
      );
    }
  }
  for (const socketPath of [manifest.observerSocketPath, manifest.hostSocketPath]) {
    const holders = socketHolders(socketPath, manifest);
    if (holders.length > 0) {
      failures.push(
        new Error(`private socket ${socketPath} still has owners: ${holders.join(", ")}`),
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Private tmux cleanup could not prove every owner exited; retained ${manifest.root}.`,
    );
  }
  rmSync(manifest.root, { recursive: true, force: true });
  if (existsSync(manifest.root)) {
    throw new Error(`Private tmux root remained after cleanup: ${manifest.root}`);
  }
}

async function terminateObserver(manifest) {
  const identity = manifest.observerIdentity;
  if (identity === null || !processExists(identity.pid)) {
    return;
  }
  if (await waitForPidExit(identity.pid, identity.osStartTime, 2_000)) {
    return;
  }
  assertObserverOwnership(manifest, identity);
  process.kill(identity.pid, "SIGTERM");
  if (await waitForPidExit(identity.pid, identity.osStartTime, 3_000)) {
    return;
  }
  assertObserverOwnership(manifest, identity);
  process.kill(identity.pid, "SIGKILL");
  if (!(await waitForPidExit(identity.pid, identity.osStartTime, 2_000))) {
    throw new Error(`Private Observer ${identity.pid} survived SIGKILL.`);
  }
}

function assertObserverOwnership(manifest, identity) {
  const currentIdentity = readObserverIdentity(manifest.observerSocketPath);
  if (JSON.stringify(currentIdentity) !== JSON.stringify(identity)) {
    throw new Error(`Private Observer pidfile changed for process ${identity.pid}.`);
  }
  const record = processRecord(identity.pid);
  if (
    record === undefined ||
    record.startTime !== identity.osStartTime ||
    !record.command.includes("observerMain.js") ||
    !record.command.includes(`--socket ${manifest.observerSocketPath}`) ||
    !record.command.includes(`--state-dir ${manifest.stateDir}`)
  ) {
    throw new Error(`Private Observer process evidence no longer matches pid ${identity.pid}.`);
  }
  if (existsSync(manifest.observerSocketPath)) {
    const holders = socketHolders(manifest.observerSocketPath, manifest);
    if (holders.length !== 1 || holders[0] !== identity.pid) {
      throw new Error(
        `Private Observer socket ownership is ambiguous: ${holders.join(", ") || "none"}.`,
      );
    }
  }
}

async function terminateHost(manifest) {
  const records = processRecords();
  const host = findHostRecord(records, manifest);
  if (host === undefined) {
    return;
  }
  const matches = records.filter((record) => isHostRecord(record, manifest));
  if (matches.length !== 1) {
    throw new Error(
      `Private Station Host ownership is ambiguous: ${matches.map((record) => record.pid).join(", ")}`,
    );
  }
  assertHostOwnership(manifest, host);
  process.kill(host.pid, "SIGTERM");
  if (await waitForPidExit(host.pid, host.startTime, 3_000)) {
    return;
  }
  const current = processRecord(host.pid);
  if (
    current === undefined ||
    current.startTime !== host.startTime ||
    current.command !== host.command
  ) {
    throw new Error(`Private Station Host ${host.pid} changed before forced cleanup.`);
  }
  assertHostOwnership(manifest, current);
  process.kill(host.pid, "SIGKILL");
  if (!(await waitForPidExit(host.pid, host.startTime, 2_000))) {
    throw new Error(`Private Station Host ${host.pid} survived SIGKILL.`);
  }
}

function assertHostOwnership(manifest, host) {
  if (!isHostRecord(host, manifest)) {
    throw new Error(`Private Station Host process evidence changed for pid ${host.pid}.`);
  }
  if (existsSync(manifest.hostSocketPath)) {
    const holders = socketHolders(manifest.hostSocketPath, manifest);
    if (!holders.includes(host.pid)) {
      throw new Error(`Private Station Host ${host.pid} no longer owns its recorded socket.`);
    }
  }
}

async function waitAsForegroundOwner() {
  await new Promise((resolveWait, rejectWait) => {
    let finishing = false;
    const handlers = new Map();
    const timer = setInterval(() => {
      if (!existsSync(manifestPath)) {
        finish();
        resolveWait();
        return;
      }
      try {
        const manifest = readManifest();
        if (manifest.devOwnerPid !== process.pid) {
          finish();
          resolveWait();
        }
      } catch (error) {
        finish();
        rejectWait(error);
      }
    }, 500);
    const finish = () => {
      if (finishing) {
        return false;
      }
      finishing = true;
      clearInterval(timer);
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
      return true;
    };
    for (const signal of Object.keys(signalExitCodes)) {
      const handler = () => {
        if (!finish()) {
          return;
        }
        void (async () => {
          try {
            if (existsSync(privateRoot)) {
              await cleanupLane(readManifest());
            }
            process.exitCode = signalExitCodes[signal];
            resolveWait();
          } catch (error) {
            rejectWait(error);
          }
        })();
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  });
}

function observerIdentityAlive(manifest, identity) {
  if (identity === null || !processExists(identity.pid)) {
    return false;
  }
  try {
    assertObserverOwnership(manifest, identity);
    return true;
  } catch {
    return false;
  }
}

function privateServerAlive(manifest) {
  if (!existsSync(manifest.tmuxWrapper)) {
    return false;
  }
  return (
    run(manifest.tmuxWrapper, ["list-sessions"], {
      cwd: manifest.root,
      env: laneEnvironment(manifest),
      check: false,
      timeoutMs: 5_000,
    }).status === 0
  );
}

function privateSessionExists(manifest, sessionName) {
  return (
    run(manifest.tmuxWrapper, ["has-session", "-t", sessionName], {
      cwd: manifest.root,
      env: laneEnvironment(manifest),
      check: false,
      timeoutMs: 5_000,
    }).status === 0
  );
}

function privateTmuxOutput(manifest, args, check = true) {
  const result = run(manifest.tmuxWrapper, args, {
    cwd: manifest.root,
    env: laneEnvironment(manifest),
    check,
    timeoutMs: 5_000,
  });
  return result.stdout.trim();
}

function socketHolders(socketPath, manifest) {
  if (!existsSync(socketPath)) {
    return [];
  }
  const lsof = requireExecutableFromManifest(manifest, "lsof");
  const result = run(lsof, ["-t", socketPath], {
    check: false,
    timeoutMs: 5_000,
  });
  return result.stdout
    .split(/\r?\n/u)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function requireExecutableFromManifest(_manifest, name) {
  return requireExecutable(name);
}

function processRecords() {
  const result = run(psPath, ["-axww", "-o", "pid=,ppid=,lstart=,command="], {
    check: false,
    timeoutMs: 10_000,
    env: { ...process.env, LC_ALL: "C" },
  });
  return result.stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/u.exec(line);
    if (match === null) {
      return [];
    }
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        startTime: match[3].trim(),
        command: match[4],
      },
    ];
  });
}

function processRecord(pid) {
  return processRecords().find((record) => record.pid === pid);
}

function processStartTime(pid) {
  return processRecord(pid)?.startTime;
}

function processMatchesStart(pid, startTime) {
  return processRecord(pid)?.startTime === startTime;
}

function descendantRecords(records, ancestorPid) {
  const byPid = new Map(records.map((record) => [record.pid, record]));
  return records.filter((record) => {
    const visited = new Set();
    let current = record.ppid;
    while (current > 0 && !visited.has(current)) {
      if (current === ancestorPid) {
        return true;
      }
      visited.add(current);
      current = byPid.get(current)?.ppid ?? 0;
    }
    return false;
  });
}

function findHostRecord(records, manifest) {
  const matches = records.filter((record) => isHostRecord(record, manifest));
  return matches.length === 1 ? matches[0] : undefined;
}

function isHostRecord(record, manifest) {
  return (
    record.command.includes("hostMain.ts") &&
    record.command.includes(`--socket ${manifest.hostSocketPath}`) &&
    record.command.includes(`--state-dir ${manifest.stateDir}`)
  );
}

function panePidFromEvidence(evidence) {
  const pid = Number(evidence.split("\t")[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function formatPane(evidence) {
  if (evidence.length === 0) {
    return " (missing)";
  }
  const [pane, pid] = evidence.split("\t");
  return ` (${pane ?? "pane?"}, pid ${pid ?? "?"})`;
}

async function waitForRecordedProcessExit(record, timeoutMs) {
  return waitForPidExit(record.pid, record.startTime, timeoutMs);
}

async function terminateRecordedPrivateProcess(record) {
  if (await waitForRecordedProcessExit(record, 1_000)) {
    return;
  }
  assertRecordedProcessOwnership(record);
  process.kill(record.pid, "SIGTERM");
  if (await waitForRecordedProcessExit(record, 3_000)) {
    return;
  }
  assertRecordedProcessOwnership(record);
  process.kill(record.pid, "SIGKILL");
  if (!(await waitForRecordedProcessExit(record, 2_000))) {
    throw new Error(`Private base-shell process ${record.pid} survived SIGKILL.`);
  }
}

function assertRecordedProcessOwnership(record) {
  const current = processRecord(record.pid);
  if (
    current === undefined ||
    current.startTime !== record.startTime ||
    current.command !== record.command
  ) {
    throw new Error(`Private base-shell process ${record.pid} changed before cleanup.`);
  }
}

async function waitForPidExit(pid, startTime, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processMatchesStart(pid, startTime)) {
      return true;
    }
    await delay(100);
  }
  return !processMatchesStart(pid, startTime);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function laneEnvironment(manifest, additions = {}) {
  const env = {};
  // Private homes do not isolate credentials exported through the caller's environment.
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (lanePassthroughEnvironmentVariables.has(key) || key.startsWith("LC_"))
    ) {
      env[key] = value;
    }
  }
  return {
    ...env,
    PATH: `${manifest.binDir}:${env.PATH ?? ""}`,
    HOME: manifest.homeDir,
    XDG_CONFIG_HOME: manifest.xdgConfigDir,
    XDG_STATE_HOME: manifest.xdgStateDir,
    XDG_DATA_HOME: manifest.xdgDataDir,
    XDG_RUNTIME_DIR: manifest.runtimeDir,
    TMPDIR: manifest.tempDir,
    CODEX_HOME: manifest.providerCodexHome,
    CLAUDE_CONFIG_DIR: manifest.providerClaudeHome,
    STATION_CURSOR_HOME: manifest.providerCursorHome,
    OPENCODE_CONFIG_DIR: manifest.providerOpenCodeHome,
    STATION_CONFIG_PATH: manifest.configPath,
    STATION_OBSERVER_SOCKET_PATH: manifest.observerSocketPath,
    STATION_HOST_SOCKET_PATH: manifest.hostSocketPath,
    STATION_LAYOUT_PATH: manifest.layoutPath,
    STATION_TMUX_BIN: manifest.tmuxWrapper,
    STATION_BUN: resolveExecutable(process.env.STATION_BUN ?? "bun") ?? "bun",
    STATION_HOST_ENTRY: hostEntry,
    TMUX_TMPDIR: manifest.tmuxTmpDir,
    SHELL: "/bin/sh",
    TERM: env.TERM ?? "xterm-256color",
    ...additions,
  };
}

function requireExecutable(requested) {
  const resolved = resolveExecutable(requested);
  if (resolved === undefined) {
    throw new Error(`Missing required executable: ${requested}`);
  }
  return resolved;
}

function resolveExecutable(requested) {
  if (requested.includes("/")) {
    const candidate = resolve(requested);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return undefined;
    }
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = join(directory, requested);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

function run(command, args, options = {}) {
  const { check = true, cwd = repoRoot, env = process.env, stdio = "pipe" } = options;
  const timeoutMs = Object.hasOwn(options, "timeoutMs") ? options.timeoutMs : 30_000;
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio,
    encoding: stdio === "pipe" ? "utf8" : undefined,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  const status = result.status ?? 1;
  const output = {
    status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
  if (check && status !== 0) {
    throw new Error(
      `\`${command} ${args.join(" ")}\` failed (exit ${status}).\n${output.stderr || output.stdout}`,
    );
  }
  return output;
}

function writeManagedFile(path, content, mode) {
  writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode });
  chmodSync(path, mode);
}

function pathInside(root, path) {
  const rel = relative(root, path);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function nullablePositiveInteger(value) {
  return value === null || (Number.isInteger(value) && value > 0);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} was not a positive integer: ${value}`);
  }
  return parsed;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function staleLaneError(manifest) {
  return new Error(
    `The private tmux lane at ${manifest.root} is partial or stale. Recover it with:\n\n` +
      "  pnpm station:devbox tmux reset --yes\n" +
      "  pnpm station:devbox tmux dev",
  );
}

function errorMessage(error) {
  if (error instanceof AggregateError) {
    return `${error.message}\n${error.errors.map((entry) => `- ${errorMessage(entry)}`).join("\n")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function log(message) {
  process.stdout.write(`${message}\n`);
}
