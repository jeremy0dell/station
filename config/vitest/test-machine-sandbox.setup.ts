import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach } from "vitest";
import { gitLocalEnvironmentVariables } from "../../packages/runtime/src/gitEnvironment.js";

const stationEnvironmentVariables = [
  "STATION_CONFIG_PATH",
  "STATION_OBSERVER_SOCKET_PATH",
  "STATION_HOST_SOCKET_PATH",
  "STATION_LAYOUT_PATH",
  "STATION_CURSOR_HOOKS_PATH",
  "STATION_WORKTRUNK_BIN",
  "STATION_TMUX_BIN",
  "STATION_GH_BIN",
  "STATION_CLAUDE_BIN",
  "STATION_CODEX_BIN",
  "STATION_CURSOR_AGENT_BIN",
  "STATION_OPENCODE_BIN",
  "STATION_PI_BIN",
  "STATION_SOURCE",
  "STATION_SCENARIO",
  "STATION_PTY_IMPL",
  "STATION_NODE",
  "STATION_BUN",
  "STATION_HOST_ENTRY",
  "STATION_INGRESS_BIN",
  "STATION_DASHBOARD_COMMAND",
  "STATION_TUI_COMMAND",
  "STATION_TUI_SESSION_NAME",
  "STATION_SHELL_AUTOCLOSE",
  "STATION_PROFILE",
  "STATION_PROJECT_ID",
  "STATION_WORKTREE_ID",
  "STATION_WORKTREE_PATH",
  "STATION_WORKTREE_MANAGED_ROOT",
  "STATION_SESSION_ID",
  "STATION_HARNESS_PROVIDER",
  "STATION_TERMINAL_PROVIDER",
  "STATION_TERMINAL_TARGET_ID",
  "STATION_OBSERVER_STATE_DIR",
  "STATION_STATE_DIR",
  "STATION_HOOK_SPOOL_DIR",
  "STATION_CLIENT_BUILD_VERSION",
  "STATION_OBSERVER_BUILD_VERSION",
  "STATION_PANE",
  "STATION_OUTER_TMUX",
  "STATION_OUTER_TMUX_PANE",
  "STATION_TUI_POPUP",
  "STATION_TUI_PERSISTENT",
  "STATION_FOCUS_PROVIDER",
  "STATION_FOCUS_CLIENT_ID",
] as const;

const credentialEnvironmentVariables = [
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

const workerEnvironment = process.env;
const originalEnvironment = { ...workerEnvironment };
const originalTemporaryDirectory = tmpdir();
const keepRoot = originalEnvironment.STATION_TEST_MACHINE_KEEP_ROOT === "1";
let machineRoot = "";
let temporaryDirectoryAlias: string | undefined;
let exitCleanupPending = false;

function removeMachineRootOnExit(): void {
  if (!exitCleanupPending) return;
  if (temporaryDirectoryAlias !== undefined) {
    rmSync(temporaryDirectoryAlias, { force: true });
  }
  if (!keepRoot && machineRoot.length > 0) {
    rmSync(machineRoot, { recursive: true, force: true });
  }
}

machineRoot = mkdtempSync(join(originalTemporaryDirectory, "s-"));
exitCleanupPending = true;
// This fallback covers failures before Vitest teardown; SIGKILL still cannot run process cleanup.
process.once("exit", removeMachineRootOnExit);

const home = join(machineRoot, "home");
const temporaryDirectory = join(machineRoot, "tmp");
const xdgConfig = join(machineRoot, "xdg", "config");
const xdgData = join(machineRoot, "xdg", "data");
const xdgCache = join(machineRoot, "xdg", "cache");
const xdgState = join(machineRoot, "xdg", "state");
const xdgRuntime = join(machineRoot, "xdg", "runtime");
const claudeHome = join(machineRoot, "harness", "claude");
const codexHome = join(machineRoot, "harness", "codex");
const cursorHome = join(machineRoot, "harness", "cursor");
const openCodeHome = join(machineRoot, "harness", "opencode");
const gitConfig = join(machineRoot, "git", "global.gitconfig");

for (const directory of [
  home,
  temporaryDirectory,
  xdgConfig,
  xdgData,
  xdgCache,
  xdgState,
  xdgRuntime,
  claudeHome,
  codexHome,
  cursorHome,
  openCodeHome,
  join(machineRoot, "git"),
]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
writeFileSync(gitConfig, "", { mode: 0o600 });

let redirectedTemporaryDirectory = temporaryDirectory;
// A short symlink keeps nested Unix socket fixtures below macOS's 104-byte path limit.
if (process.platform !== "win32" && temporaryDirectory.length >= 40) {
  temporaryDirectoryAlias = join("/tmp", `st-${process.pid}-${basename(machineRoot)}`);
  symlinkSync(temporaryDirectory, temporaryDirectoryAlias, "dir");
  redirectedTemporaryDirectory = temporaryDirectoryAlias;
}

const sandboxEnvironment: NodeJS.ProcessEnv = {
  ...originalEnvironment,
  HOME: home,
  TMPDIR: redirectedTemporaryDirectory,
  TMP: redirectedTemporaryDirectory,
  TEMP: redirectedTemporaryDirectory,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
  XDG_CACHE_HOME: xdgCache,
  XDG_STATE_HOME: xdgState,
  XDG_RUNTIME_DIR: xdgRuntime,
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: claudeHome,
  STATION_CURSOR_HOME: cursorHome,
  OPENCODE_CONFIG_DIR: openCodeHome,
  GH_CONFIG_DIR: join(xdgConfig, "gh"),
  GIT_CONFIG_GLOBAL: gitConfig,
  ZDOTDIR: home,
  HISTFILE: join(home, ".shell_history"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  STATION_TEST_MACHINE_ROOT: machineRoot,
};

for (const key of [
  ...stationEnvironmentVariables,
  ...gitLocalEnvironmentVariables,
  ...credentialEnvironmentVariables,
  "TMUX",
  "TMUX_PANE",
]) {
  delete sandboxEnvironment[key];
}
restoreEnvironment(sandboxEnvironment);

function restoreEnvironment(environment: NodeJS.ProcessEnv): void {
  if (process.env !== workerEnvironment) process.env = workerEnvironment;
  for (const key of Object.keys(workerEnvironment)) {
    if (!(key in environment)) delete workerEnvironment[key];
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) workerEnvironment[key] = value;
  }
}

afterEach(() => {
  restoreEnvironment(sandboxEnvironment);
});

afterAll(() => {
  restoreEnvironment(originalEnvironment);
  if (temporaryDirectoryAlias !== undefined) {
    rmSync(temporaryDirectoryAlias, { force: true });
  }
  if (keepRoot) {
    process.stderr.write(`[station test machine] retained root: ${machineRoot}\n`);
  } else {
    rmSync(machineRoot, { recursive: true, force: true });
  }
  exitCleanupPending = false;
  process.off("exit", removeMachineRootOnExit);
});
