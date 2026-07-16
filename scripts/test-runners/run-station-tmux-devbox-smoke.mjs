#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const wrapperPath = join(repoRoot, "scripts", "station-devbox.mjs");
const cliPath = join(repoRoot, "apps", "cli", "dist", "main.js");
const hmrTarget = join(repoRoot, "station", "src", "dashboardRenderer", "FullscreenDashboard.tsx");
const hmrTargetRelative = "station/src/dashboardRenderer/FullscreenDashboard.tsx";
const checkoutKey = createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 12);
const privateRoot = join("/tmp", `stn-dbx-${checkoutKey}`);
const manifestPath = join(privateRoot, "manifest.json");
const probe = "tmux-devbox-hmr-probe";
const timeoutMs = Number(process.env.STATION_TMUX_DEVBOX_SMOKE_TIMEOUT_MS ?? 180_000);
const ptyBridgeScript = `
import fcntl
import os
import pty
import select
import struct
import sys
import termios

winsize = struct.pack("HHHH", 40, 120, 0, 0)
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(sys.stdin.fileno(), termios.TIOCSWINSZ, winsize)
    os.environ.setdefault("TERM", "xterm-256color")
    os.execvp(sys.argv[1], sys.argv[1:])

fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
while True:
    readable, _, _ = select.select([sys.stdin.buffer, fd], [], [])
    if sys.stdin.buffer in readable:
        data = os.read(sys.stdin.fileno(), 4096)
        if not data:
            break
        os.write(fd, data)
    if fd in readable:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)

try:
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
except ChildProcessError:
    sys.exit(0)
`;

const outerRoot = mkdtempSync("/tmp/stn-tmux-devbox-smoke-");
const outerHome = join(outerRoot, "home");
const outerConfig = join(outerRoot, "xdg-config");
const outerState = join(outerRoot, "xdg-state");
const outerRuntime = join(outerRoot, "run");
const outerSentinels = [
  join(outerHome, ".config", "station", "config.toml"),
  join(outerHome, ".codex", "auth.json"),
  join(outerHome, ".claude", "settings.json"),
  join(outerState, "station", "observer.sock"),
  join(outerState, "station", "hooks", "sentinel"),
];
const credentialSentinels = {
  ANTHROPIC_API_KEY: "station-tmux-smoke-anthropic",
  AWS_SECRET_ACCESS_KEY: "station-tmux-smoke-aws",
  GH_TOKEN: "station-tmux-smoke-gh",
  GITHUB_TOKEN: "station-tmux-smoke-github",
  OPENAI_API_KEY: "station-tmux-smoke-openai",
  SSH_AUTH_SOCK: join(outerRoot, "ssh-agent.sock"),
};
const outerEnv = sanitizeGitEnvironment({
  ...process.env,
  ...credentialSentinels,
  HOME: outerHome,
  XDG_CONFIG_HOME: outerConfig,
  XDG_STATE_HOME: outerState,
  XDG_RUNTIME_DIR: outerRuntime,
  STATION_CONFIG_PATH: outerSentinels[0],
  STATION_OBSERVER_SOCKET_PATH: outerSentinels[3],
  STATION_HOOK_SPOOL_DIR: dirname(outerSentinels[4]),
  STATION_SOURCE: "mock",
});
const targetBytes = readFileSync(hmrTarget);
const targetMode = statSync(hmrTarget).mode & 0o777;
const preStatus = git(["status", "--porcelain=v1"]);
const preDiff = git(["diff", "--no-ext-diff", "--binary"]);
const sentinelBytes = new Map();
let ptyClient;
let probeTargetBytes;
let finalRestorationError;
let ownsPrivateLane = false;

process.stderr.write(
  "station:devbox:tmux smoke — real private tmux, Observer, popup, PTY, and source HMR.\n",
);

try {
  assert(!existsSync(privateRoot), `private lane is already running at ${privateRoot}`);
  assert(
    gitStatus(["diff", "--quiet", "--", hmrTargetRelative]) === 0,
    `HMR target is dirty; refusing to edit ${hmrTarget}`,
  );
  assert(existsSync(cliPath), `built CLI missing at ${cliPath}; run pnpm build`);
  checked("python3", ["--version"], { env: outerEnv });
  checked("tmux", ["-V"], { env: outerEnv });
  checked("bun", ["--version"], { env: outerEnv });
  checked("node", [cliPath, "--version"], { env: outerEnv });
  createOuterSentinels();

  const help = devbox(["tmux", "help"]);
  assertIncludes(help.stdout, "tmux dev", "nested help");
  const resetRefusal = devbox(["tmux", "reset"], { check: false });
  assert(resetRefusal.status !== 0, "reset unexpectedly succeeded without --yes");
  assertIncludes(resetRefusal.stderr, "Refusing to reset without --yes", "reset refusal");

  const firstStart = devbox(["tmux", "start"]);
  ownsPrivateLane = true;
  const manifest = readManifest();
  assertOwnershipOutput(firstStart.stdout, manifest);
  const preexistingLaneRefusal = checked(process.execPath, [fileURLToPath(import.meta.url)], {
    env: outerEnv,
    check: false,
  });
  assert(preexistingLaneRefusal.status !== 0, "nested smoke reused a preexisting private lane");
  assertIncludes(
    preexistingLaneRefusal.stderr,
    `private lane is already running at ${privateRoot}`,
    "preexisting lane refusal",
  );
  const manifestAfterRefusal = readManifest();
  assert(
    manifestAfterRefusal.tmuxServerPid === manifest.tmuxServerPid &&
      manifestAfterRefusal.observerIdentity.pid === manifest.observerIdentity.pid &&
      privateSessionExists(manifest, manifest.baseSession),
    "preexisting lane refusal stopped or replaced the private lane",
  );
  const secondStart = devbox(["tmux", "start"]);
  assertOwnershipOutput(secondStart.stdout, manifest);
  const initialStatus = devbox(["tmux", "status"]);
  assertOwnershipOutput(initialStatus.stdout, manifest);
  devbox(["tmux", "logs"]);

  proveManifestAndIsolation(manifest);
  ptyClient = await startPtyClient(manifest);
  assertPrivateServerEnvironment(manifest);
  await proveBaseShellIsolation(manifest);
  await triggerPopup(ptyClient);
  await waitFor(
    () => privateSessionExists(manifest, manifest.hiddenSession),
    "hidden Station session did not appear",
  );
  await waitFor(
    () => captureHiddenPane(manifest).includes("SESSION"),
    "real dashboard did not paint",
  );

  const beforeHmr = runtimeEvidence(manifest);
  assert(beforeHmr.cli !== undefined, "hidden pane is not the production CLI parent");
  assert(beforeHmr.renderer !== undefined, "Bun dashboard renderer child was not found");
  const popupLauncher = readFileSync(manifest.popupLauncherPath, "utf8");
  assert(
    popupLauncher.includes("--hot --no-clear-screen") &&
      popupLauncher.includes("src/dashboardRenderer/main.tsx"),
    "popup launcher does not use the required Bun hot renderer command",
  );
  const serverDashboardCommand = tmux(manifest, [
    "show-environment",
    "-g",
    "STATION_DASHBOARD_COMMAND",
  ]).stdout;
  assert(
    serverDashboardCommand.includes("--hot --no-clear-screen") &&
      serverDashboardCommand.includes("src/dashboardRenderer/main.tsx"),
    "private tmux server did not retain the hot dashboard command",
  );
  assert(beforeHmr.nestedClientPid !== undefined, "nested popup client was not found");
  const rendererTerminalLog = join(manifest.root, "logs", "renderer-terminal.log");
  tmux(manifest, [
    "pipe-pane",
    "-o",
    "-t",
    manifest.hiddenSession,
    `cat >> ${rendererTerminalLog}`,
  ]);

  const liveStatus = devbox(["tmux", "status"]);
  for (const expected of [
    `CLI parent:     ${beforeHmr.cli.pid}`,
    `Bun renderer:   ${beforeHmr.renderer.pid}`,
    `renderer IPC:   ${beforeHmr.cli.pid} -> ${beforeHmr.renderer.pid}`,
  ]) {
    assertIncludes(liveStatus.stdout, expected, "live ownership status");
  }

  const source = targetBytes.toString("utf8");
  const insertion = "        <DashboardRoot store={store} columns={width} rows={height} />";
  assert(source.includes(insertion), `HMR insertion point missing from ${hmrTarget}`);
  const nextProbeTargetBytes = Buffer.from(
    source.replace(insertion, `        <text>${probe}</text>\n${insertion}`),
    "utf8",
  );
  assertTargetUnchanged("before the HMR probe write");
  writeFileSync(hmrTarget, nextProbeTargetBytes);
  probeTargetBytes = nextProbeTargetBytes;
  try {
    await waitFor(
      () => captureHiddenPane(manifest).includes(probe),
      "Bun HMR did not repaint the open popup with the source probe",
      30_000,
    );
  } catch (error) {
    const rendererOutput = existsSync(rendererTerminalLog)
      ? readFileSync(rendererTerminalLog, "utf8").slice(-16_000)
      : "<renderer terminal log absent>";
    throw new Error(
      `${error.message}\nHidden pane:\n${captureHiddenPane(manifest)}\nRenderer output:\n${rendererOutput}`,
      { cause: error },
    );
  }
  const duringHmr = runtimeEvidence(manifest);
  assertStableRuntime(beforeHmr, duringHmr, "probe insertion");

  const restorationError = restoreTarget();
  if (restorationError !== undefined) {
    throw restorationError;
  }
  await waitFor(
    () => !captureHiddenPane(manifest).includes(probe),
    "Bun HMR did not remove the restored source probe",
    30_000,
  );
  const afterHmr = runtimeEvidence(manifest);
  assertStableRuntime(beforeHmr, afterHmr, "probe restoration");

  await ptyClient.write(Buffer.from([0x1b]));
  await waitFor(
    () => runtimeEvidence(manifest).nestedClientPid === undefined,
    "Esc did not dismiss the original popup IPC channel",
  );
  const afterDismiss = runtimeEvidence(manifest);
  assert(afterDismiss.cli?.pid === beforeHmr.cli.pid, "dismiss replaced the CLI parent");
  assert(
    afterDismiss.renderer?.pid === beforeHmr.renderer.pid,
    "dismiss replaced the Bun renderer",
  );
  assertWrapperAudit(manifest);
  assert(!existsSync(manifest.bareTmuxLogPath), "a child invoked bare/default tmux");

  await ptyClient.close();
  ptyClient = undefined;
  devbox(["tmux", "stop"]);
  devbox(["tmux", "stop"]);
  assert(!existsSync(privateRoot), "stop did not remove the private root");

  await proveBaseDescendantCleanup();
  await proveVerifiedPartialReset();
  await proveFailedStartupRollback();
  await proveSignals();
  proveOuterSentinels();
  assert(readFileSync(hmrTarget).equals(targetBytes), "HMR target bytes changed after smoke");
  assert(git(["status", "--porcelain=v1"]) === preStatus, "git status changed during smoke");
  assert(git(["diff", "--no-ext-diff", "--binary"]) === preDiff, "git diff changed during smoke");

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "station:devbox:tmux smoke passed",
        privateRoot,
        stablePids: {
          tmuxServer: beforeHmr.serverPid,
          basePane: beforeHmr.basePanePid,
          hiddenPane: beforeHmr.hiddenPanePid,
          cli: beforeHmr.cli.pid,
          renderer: beforeHmr.renderer.pid,
          observer: beforeHmr.observerPid,
          nestedClient: beforeHmr.nestedClientPid,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  finalRestorationError = restoreTarget();
  if (ptyClient !== undefined) {
    await ptyClient.close().catch(() => undefined);
  }
  if (ownsPrivateLane) {
    devbox(["tmux", "stop"], { check: false });
  }
  rmSync(outerRoot, { recursive: true, force: true });
  if (finalRestorationError !== undefined) {
    process.stderr.write(`${finalRestorationError.message}\n`);
  }
}
if (finalRestorationError !== undefined) {
  throw finalRestorationError;
}

function createOuterSentinels() {
  for (const [index, path] of outerSentinels.entries()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(`outer-sentinel-${index}\n`);
    writeFileSync(path, bytes, { mode: 0o600 });
    sentinelBytes.set(path, bytes);
  }
}

function proveOuterSentinels() {
  for (const [path, bytes] of sentinelBytes) {
    assert(readFileSync(path).equals(bytes), `outer sentinel changed: ${path}`);
  }
}

function proveManifestAndIsolation(manifest) {
  const rootStat = statSync(manifest.root);
  const manifestStat = statSync(manifestPath);
  assert((rootStat.mode & 0o077) === 0, "private root is not mode 0700");
  assert((manifestStat.mode & 0o077) === 0, "manifest is not mode 0600");
  for (const key of [
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
    "tmuxWrapper",
    "tmuxTmpDir",
    "tmuxSocketPath",
    "tmuxLogPath",
    "bareTmuxShimPath",
    "bareTmuxLogPath",
    "popupLauncherPath",
    "popupLogPath",
  ]) {
    assert(pathInside(manifest.root, manifest[key]), `manifest path escapes root: ${key}`);
  }
  for (const socketPath of [
    manifest.observerSocketPath,
    manifest.hostSocketPath,
    manifest.tmuxSocketPath,
  ]) {
    assert(socketPath.length < 104, `Unix socket path is too long: ${socketPath}`);
  }
  assert(existsSync(manifest.observerSocketPath), "private Observer socket is absent");
  assert(existsSync(manifest.tmuxSocketPath), "private tmux socket is absent");
  assert(!existsSync(manifest.hostSocketPath), "read-only lane unexpectedly started Station Host");
  assert(!existsSync(manifest.bareTmuxLogPath), "a child invoked the failing bare tmux shim");
  assertPrivateServerEnvironment(manifest);
  assertNoLinks(manifest.providerCodexHome);
  assertNoLinks(manifest.providerClaudeHome);
  assertNoLinks(manifest.providerCursorHome);
  assertNoLinks(manifest.providerOpenCodeHome);
  assert(
    git(["-C", manifest.projectRoot, "rev-parse", "--verify", "HEAD"]).length > 0,
    "project is uncommitted",
  );
  assert(
    git(["-C", manifest.projectRoot, "status", "--porcelain=v1"]).length === 0,
    "disposable project is dirty",
  );
  checked(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { loadConfig } from './packages/config/dist/index.js'; await loadConfig(process.argv[1]);",
      manifest.configPath,
    ],
    { cwd: repoRoot, env: outerEnv },
  );
  assertWrapperAudit(manifest);
}

function assertWrapperAudit(manifest) {
  const wrapperLines = readFileSync(manifest.tmuxLogPath, "utf8").split(/\r?\n/u).filter(Boolean);
  assert(wrapperLines.length > 0, "private wrapper log is empty");
  for (const line of wrapperLines) {
    assertIncludes(line, `\t-L\t${manifest.tmuxLabel}\t-f\t/dev/null`, "wrapper audit");
  }
}

function assertPrivateServerEnvironment(manifest) {
  assert(
    tmux(manifest, ["show-options", "-gv", "update-environment"]).stdout.trim() === "",
    "private tmux server can import client environment variables",
  );
  const serverEnvironment = tmux(manifest, ["show-environment", "-g"], {
    check: false,
  }).stdout;
  for (const name of Object.keys(credentialSentinels)) {
    assert(
      !new RegExp(`(^|\\n)${name}=`, "u").test(serverEnvironment),
      `private tmux server inherited ${name}`,
    );
  }
}

async function proveBaseShellIsolation(manifest) {
  const reportPath = join(manifest.root, "base-shell-tmux-path");
  tmux(manifest, [
    "send-keys",
    "-t",
    `${manifest.baseSession}:0.0`,
    `command -v tmux > ${reportPath}`,
    "Enter",
  ]);
  await waitFor(() => existsSync(reportPath), "base shell did not write its tmux path");
  const resolvedTmux = readFileSync(reportPath, "utf8").trim();
  assert(
    resolvedTmux === manifest.bareTmuxShimPath,
    `base shell resolves bare tmux outside the private guard: ${resolvedTmux}`,
  );
}

async function proveBaseDescendantCleanup() {
  devbox(["tmux", "start"]);
  const manifest = readManifest();
  const pidPath = join(manifest.root, "base-descendant.pid");
  tmux(manifest, [
    "send-keys",
    "-t",
    `${manifest.baseSession}:0.0`,
    `/usr/bin/nohup /bin/sleep 300 >/dev/null 2>&1 & echo $! > ${pidPath}`,
    "Enter",
  ]);
  await waitFor(() => existsSync(pidPath), "base descendant pid did not appear");
  const pid = positiveInteger(readFileSync(pidPath, "utf8"), "base descendant pid");
  await waitFor(() => processExists(pid), "base descendant did not start");
  try {
    devbox(["tmux", "stop"]);
    assert(!processExists(pid), `private base descendant ${pid} survived stop`);
  } finally {
    if (processExists(pid)) {
      process.kill(pid, "SIGKILL");
    }
    devbox(["tmux", "stop"], { check: false });
  }
}

async function proveVerifiedPartialReset() {
  devbox(["tmux", "start"]);
  const manifest = readManifest();
  tmux(manifest, ["kill-server"], { check: false });
  assert(existsSync(manifest.root), "partial root disappeared before reset proof");
  devbox(["tmux", "reset", "--yes"]);
  assert(!existsSync(manifest.root), "reset did not remove verified partial root");
}

async function proveFailedStartupRollback() {
  const fakeTmux = join(outerRoot, "fake-tmux");
  writeFileSync(
    fakeTmux,
    [
      "#!/bin/sh",
      `if [ "\${1:-}" = "-V" ]; then echo "tmux fake-smoke"; exit 0; fi`,
      "exit 88",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeTmux, 0o700);
  const failed = devbox(["tmux", "start"], {
    check: false,
    env: { ...outerEnv, STATION_TMUX_DEVBOX_TMUX_BIN: fakeTmux },
  });
  assert(failed.status !== 0, "fake tmux startup unexpectedly succeeded");
  assert(!existsSync(privateRoot), "failed startup retained private resources");
}

async function proveSignals() {
  for (const [signal, expectedCode] of [
    ["SIGINT", 130],
    ["SIGHUP", 129],
    ["SIGTERM", 143],
  ]) {
    const owner = spawn(process.execPath, [wrapperPath, "tmux", "dev"], {
      cwd: repoRoot,
      env: outerEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    owner.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    owner.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const exit = new Promise((resolveExit, rejectExit) => {
      owner.once("error", rejectExit);
      owner.once("exit", (code, exitedSignal) => resolveExit({ code, signal: exitedSignal }));
    });
    await waitFor(
      () => stdout.includes("Foreground owner active."),
      `${signal} owner did not become ready\n${stdout}\n${stderr}`,
      30_000,
    );
    owner.kill(signal);
    const result = await withTimeout(exit, 30_000, `${signal} owner did not exit`);
    assert(
      result.code === expectedCode && result.signal === null,
      `${signal} owner exited as ${JSON.stringify(result)}\n${stdout}\n${stderr}`,
    );
    assert(!existsSync(privateRoot), `${signal} cleanup retained ${privateRoot}`);
  }
}

function assertStableRuntime(before, after, label) {
  for (const key of [
    "serverPid",
    "basePanePid",
    "hiddenPanePid",
    "observerPid",
    "nestedClientPid",
  ]) {
    assert(after[key] === before[key], `${label} changed ${key}: ${before[key]} -> ${after[key]}`);
  }
  assert(after.cli?.pid === before.cli?.pid, `${label} changed the CLI parent`);
  assert(after.renderer?.pid === before.renderer?.pid, `${label} changed the Bun renderer`);
  assert(after.hostPid === before.hostPid, `${label} changed Station Host ownership`);
}

function runtimeEvidence(manifest) {
  const serverPid = positiveInteger(
    tmux(manifest, ["display-message", "-p", "#{pid}"]).stdout,
    "tmux server pid",
  );
  const basePanePid = positiveInteger(
    tmux(manifest, ["display-message", "-p", "-t", `${manifest.baseSession}:0.0`, "#{pane_pid}"])
      .stdout,
    "base pane pid",
  );
  const hiddenPanePid = positiveInteger(
    tmux(manifest, ["display-message", "-p", "-t", `${manifest.hiddenSession}:0.0`, "#{pane_pid}"])
      .stdout,
    "hidden pane pid",
  );
  const nested = tmux(
    manifest,
    ["list-clients", "-t", manifest.hiddenSession, "-F", "#{client_pid}"],
    { check: false },
  ).stdout.trim();
  const nestedClientPid =
    nested.length === 0 ? undefined : positiveInteger(nested, "nested client pid");
  const records = processRecords();
  const processTree = [
    records.find((record) => record.pid === hiddenPanePid),
    ...descendants(records, hiddenPanePid),
  ].filter((record) => record !== undefined);
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
  const observerPid = readManifest().observerIdentity.pid;
  const host = records.find(
    (record) =>
      record.command.includes("hostMain.ts") && record.command.includes(manifest.hostSocketPath),
  );
  return {
    serverPid,
    basePanePid,
    hiddenPanePid,
    nestedClientPid,
    cli,
    renderer,
    observerPid,
    hostPid: host?.pid,
  };
}

async function startPtyClient(manifest) {
  const child = spawn(
    "python3",
    ["-c", ptyBridgeScript, process.execPath, wrapperPath, "tmux", "attach"],
    {
      cwd: manifest.projectRoot,
      env: { ...outerEnv, TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let clientName;
  await waitFor(() => {
    const output = tmux(
      manifest,
      ["list-clients", "-t", manifest.baseSession, "-F", "#{client_name}"],
      { check: false },
    ).stdout.trim();
    clientName = output.split(/\r?\n/u).find(Boolean);
    return clientName !== undefined;
  }, "ordinary PTY client did not attach");
  return {
    child,
    clientName,
    exit,
    async write(bytes) {
      if (!child.stdin.write(bytes)) {
        await new Promise((resolveDrain, rejectDrain) => {
          child.stdin.once("drain", resolveDrain);
          child.stdin.once("error", rejectDrain);
        });
      }
    },
    async close() {
      if (clientName !== undefined && privateSessionExists(manifest, manifest.baseSession)) {
        tmux(manifest, ["detach-client", "-t", clientName], { check: false });
      }
      child.stdin.end();
      child.kill("SIGTERM");
      await withTimeout(exit, 5_000, "ordinary PTY client did not exit").catch(() => undefined);
    },
  };
}

async function triggerPopup(client) {
  await client.write(Buffer.from([0x02]));
  await delay(25);
  await client.write(Buffer.from(" "));
}

function captureHiddenPane(manifest) {
  return tmux(manifest, ["capture-pane", "-p", "-t", manifest.hiddenSession], {
    check: false,
  }).stdout;
}

function privateSessionExists(manifest, sessionName) {
  return tmux(manifest, ["has-session", "-t", sessionName], { check: false }).status === 0;
}

function tmux(manifest, args, options = {}) {
  return checked(manifest.tmuxWrapper, args, {
    cwd: manifest.root,
    env: outerEnv,
    ...options,
  });
}

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function assertOwnershipOutput(output, manifest) {
  for (const expected of [
    "Station private tmux devbox: running",
    `checkout key:   ${manifest.checkoutKey}`,
    `private root:   ${manifest.root}`,
    `tmux label:     ${manifest.tmuxLabel}`,
    `tmux wrapper:   ${manifest.tmuxWrapper}`,
    "tmux config:    /dev/null",
    `config:         ${manifest.configPath}`,
    `state root:     ${manifest.stateDir}`,
    `Observer socket:${manifest.observerSocketPath}`,
    `Host socket:    ${manifest.hostSocketPath}`,
    `base session:   ${manifest.baseSession}`,
    `hidden session: ${manifest.hiddenSession}`,
    "pnpm station:devbox tmux attach",
    "pnpm station:devbox tmux logs --follow",
    "pnpm station:devbox tmux stop",
  ]) {
    assertIncludes(output, expected, "ownership output");
  }
}

function assertNoLinks(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    assert(
      !stat.isSymbolicLink(),
      `provider home contains a symlink: ${path} -> ${readlinkSync(path)}`,
    );
    if (stat.isDirectory()) {
      assertNoLinks(path);
    }
  }
}

function processRecords() {
  return checked(
    process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps",
    ["-axww", "-o", "pid=,ppid=,command="],
    { env: { ...outerEnv, LC_ALL: "C" } },
  )
    .stdout.split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return match === null
        ? []
        : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }];
    });
}

function descendants(records, ancestorPid) {
  const byPid = new Map(records.map((record) => [record.pid, record]));
  return records.filter((record) => {
    const visited = new Set();
    let pid = record.ppid;
    while (pid > 0 && !visited.has(pid)) {
      if (pid === ancestorPid) {
        return true;
      }
      visited.add(pid);
      pid = byPid.get(pid)?.ppid ?? 0;
    }
    return false;
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function devbox(args, options = {}) {
  return checked(process.execPath, [wrapperPath, ...args], {
    cwd: repoRoot,
    env: options.env ?? outerEnv,
    ...options,
  });
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? outerEnv,
    encoding: "utf8",
    timeout: options.timeoutMs ?? timeoutMs,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  const output = {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (options.check !== false && output.status !== 0) {
    throw new Error(
      `\`${command} ${args.join(" ")}\` failed (${output.status}).\n${output.stdout}\n${output.stderr}`,
    );
  }
  return output;
}

async function waitFor(predicate, message, waitMs = 10_000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(100);
  }
  throw new Error(message);
}

async function withTimeout(promise, waitMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertTargetUnchanged(stage) {
  assert(
    targetMatches(targetBytes),
    `HMR target changed ${stage}; preserving current bytes at ${hmrTarget}`,
  );
}

function restoreTarget() {
  if (probeTargetBytes === undefined || targetMatches(targetBytes)) {
    probeTargetBytes = undefined;
    return undefined;
  }
  if (!targetMatches(probeTargetBytes)) {
    return new Error(
      `HMR target changed while the smoke probe was active; preserving current bytes at ${hmrTarget}. Remove ${JSON.stringify(probe)} manually if it remains.`,
    );
  }
  try {
    writeFileSync(hmrTarget, targetBytes);
    chmodSync(hmrTarget, targetMode);
    probeTargetBytes = undefined;
    return undefined;
  } catch (error) {
    return new Error(`Could not restore the smoke-owned HMR probe at ${hmrTarget}.`, {
      cause: error,
    });
  }
}

function targetMatches(bytes) {
  if (!existsSync(hmrTarget)) {
    return false;
  }
  const targetStat = lstatSync(hmrTarget);
  return (
    targetStat.isFile() &&
    !targetStat.isSymbolicLink() &&
    (targetStat.mode & 0o777) === targetMode &&
    readFileSync(hmrTarget).equals(bytes)
  );
}

function git(args) {
  return checked("git", args, { cwd: repoRoot, env: outerEnv }).stdout;
}

function gitStatus(args) {
  return checked("git", args, { cwd: repoRoot, env: outerEnv, check: false }).status;
}

function pathInside(root, path) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(prefix);
}

function positiveInteger(value, label) {
  const parsed = Number(String(value).trim());
  assert(Number.isInteger(parsed) && parsed > 0, `${label} is invalid: ${value}`);
  return parsed;
}

function assertIncludes(value, expected, label) {
  assert(value.includes(expected), `${label} missing ${JSON.stringify(expected)}\n${value}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function sanitizeGitEnvironment(env) {
  const sanitized = { ...env };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
  ]) {
    delete sanitized[key];
  }
  return sanitized;
}
