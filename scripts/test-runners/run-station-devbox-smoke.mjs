#!/usr/bin/env node
// Scripted smoke for the root `bun run station:devbox` wrapper. Uses the no-UI seam
// (STATION_ISOLATED_NO_LAUNCH=1) to start the isolated observer without the TUI,
// then proves the wrapper targets this checkout's .dev-state (not global state)
// and tears it down. Kept out of bun run test:all (needs native Host prerequisites).
//
// Warning: runs against the real .dev-state for this checkout — it starts and
// then STOPS the devbox, so a live devbox here will be stopped.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const options = parseArgs(process.argv.slice(2));
const timeoutMs = Number(process.env.STATION_DEVBOX_SMOKE_TIMEOUT_MS ?? 180_000);

const wrapper = join(repoRoot, "scripts", "station-devbox.mjs");
const cli = join(repoRoot, "apps", "cli", "dist", "main.js");
const ds = join(repoRoot, ".dev-state");
const cfg = join(ds, "config.toml");
const socketDir = join(
  tmpdir(),
  `stn-db-${createHash("sha256").update(repoRoot).digest("hex").slice(0, 12)}`,
);
const observerSock = join(socketDir, "observer.sock");
const hostSock = join(socketDir, "station-host.sock");
const hostEntry = join(repoRoot, "station", "src", "host", "hostMain.ts");
const hooksDir = join(ds, "observer", "hooks");
const hookLog = join(ds, "observer", "logs", "hooks.jsonl");
const codexHookScript = join(hooksDir, "station-codex-hook.sh");
const codexProfileConfig = join(ds, "codex-home", "station.config.toml");
const globalStateFragment = join(".local", "state", "station");
const bunShimRoot = mkdtempSync(join(tmpdir(), "station-devbox-smoke-bun-"));
const bunInvocationLog = join(bunShimRoot, "invocations.log");
const rendererEnvironmentLog = join(bunShimRoot, "renderer-environment.log");
const bunShim = join(bunShimRoot, "bun");
const resolvedBun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" });
assert(resolvedBun.status === 0, `bun is unavailable: ${resolvedBun.stderr}`);
writeFileSync(
  bunShim,
  `#!/usr/bin/env bash
set -euo pipefail
{
  for argument in "$@"; do printf '%s\\037' "$argument"; done
  printf '\\n'
} >> "$STATION_DEVBOX_SMOKE_BUN_LOG"
if [ "\${STATION_DEVBOX_SMOKE_CAPTURE_RENDERER_ENV:-}" = "1" ] && [ "\${1:-}" = "run" ] && { [ "\${2:-}" = "station" ] || [ "\${2:-}" = "dev" ]; }; then
  : > "$STATION_DEVBOX_SMOKE_RENDERER_ENV_LOG"
  for name in \
    STATION_SOURCE STATION_SCENARIO STATION_HOST_SOCKET_PATH STATION_LAYOUT_PATH \
    STATION_OBSERVER_SOCKET_PATH STATION_CONFIG_PATH STATION_OBSERVER_STATE_DIR \
    STATION_STATE_DIR STATION_HOOK_SPOOL_DIR STATION_INGRESS_BIN STATION_HOST_HANDOFF \
    STATION_CLIENT_BUILD_VERSION STATION_OBSERVER_BUILD_VERSION STATION_UI_RUN_ID \
    STATION_PROJECT_ID STATION_WORKTREE_ID STATION_SESSION_ID STATION_CURSOR_HOOKS_PATH
  do
    if value="$(printenv "$name")"; then
      printf '%s=%s\n' "$name" "$value" >> "$STATION_DEVBOX_SMOKE_RENDERER_ENV_LOG"
    else
      printf '%s=__ABSENT__\n' "$name" >> "$STATION_DEVBOX_SMOKE_RENDERER_ENV_LOG"
    fi
  done
  exit 0
fi
exec "$STATION_DEVBOX_SMOKE_REAL_BUN" "$@"
`,
  { mode: 0o700 },
);
let socketRestricted = false;
let hostPid;
let alternateObserverPid;

process.stderr.write(
  "station:devbox smoke — starts and STOPS this checkout's devbox (.dev-state).\n",
);

try {
  if (!options.skipBuild) {
    spawnChecked("bun", ["run", "build"], { label: "build" });
  } else {
    assert(existsSync(cli), "built CLI is missing; run bun run build or omit --skip-build");
  }

  // Starting from a deliberately non-private checkout directory exercises the
  // wrapper-owned repair without weakening the Observer's generic fail-closed policy.
  devbox(["stop"], "preflight stop");
  mkdirSync(socketDir, { recursive: true });
  chmodSync(socketDir, 0o755);
  assert(
    (statSync(socketDir).mode & 0o777) === 0o755,
    `failed to seed non-private socket directory ${socketDir}`,
  );

  // Start via the no-UI seam: the wrapper delegates to the isolated path, which
  // brings up the observer + installs codex/claude hooks, then exits (no TUI).
  const start = devbox(["start"], "start", {
    PATH: `${bunShimRoot}:${process.env.PATH ?? ""}`,
    STATION_DEVBOX_SMOKE_BUN_LOG: bunInvocationLog,
    STATION_DEVBOX_SMOKE_REAL_BUN: resolvedBun.stdout.trim(),
    STATION_ISOLATED_NO_LAUNCH: "1",
  });
  const bunInvocations = readBunInvocations();
  assert(
    bunInvocations.filter((args) => args[0] === "install" && args[1] === "--frozen-lockfile")
      .length === 1,
    `headless start did not perform exactly one frozen Station install: ${JSON.stringify(bunInvocations)}`,
  );
  assert(
    !bunInvocations.some(
      (args) => args.includes("link:station") || args.includes("repair:node-pty"),
    ),
    `headless start ran a redundant link or node-pty repair: ${JSON.stringify(bunInvocations)}`,
  );
  assert(
    start.stdout.includes(observerSock),
    `start did not report the isolated observer socket ${observerSock}\n${start.stdout}`,
  );
  assertNoGlobalLeak(start.stdout, "start");
  assert(existsSync(observerSock), `isolated observer socket not created at ${observerSock}`);
  assert(
    (statSync(socketDir).mode & 0o777) === 0o700,
    `start did not repair ${socketDir} to mode 0700`,
  );
  assert(
    /^hooks\s*=\s*true\s*$/m.test(readFileSync(codexProfileConfig, "utf8")),
    `isolated Codex profile does not enable hooks: ${codexProfileConfig}`,
  );
  assertHookDoctors("initial start");

  const host = spawn(
    resolvedBun.stdout.trim(),
    [hostEntry, "--socket", hostSock, "--state-dir", join(ds, "observer")],
    { cwd: join(repoRoot, "station"), detached: true, stdio: "ignore" },
  );
  host.unref();
  hostPid = host.pid;
  assert(Number.isInteger(hostPid), "failed to launch the persistent source Host");
  await waitForPath(hostSock, "persistent Host socket");

  // status through the wrapper reports the isolated socket; the direct isolated
  // observer status must not leak the global state dir.
  const status = devbox(["status"], "status");
  assert(
    status.stdout.includes(observerSock),
    `wrapper status did not report the isolated socket\n${status.stdout}`,
  );
  const isoStatus = spawnChecked("node", [cli, "--config", cfg, "observer", "status"], {
    label: "isolated observer status",
    env: sourceCliEnv(),
  });
  assertNoGlobalLeak(isoStatus.stdout, "isolated observer status");
  const healthyStatus = parseJson(isoStatus.stdout, "isolated observer status");
  const originalPid = healthyStatus.health?.pid;
  assert(
    Number.isInteger(originalPid),
    `isolated status did not report a PID\n${isoStatus.stdout}`,
  );
  const originalSocket = statSync(observerSock);

  devbox(["start"], "exact reopen", { STATION_ISOLATED_NO_LAUNCH: "1" });
  const exactReopenStatus = spawnChecked("node", [cli, "--config", cfg, "observer", "status"], {
    label: "exact reopen observer status",
    env: sourceCliEnv(),
  });
  assert(
    parseJson(exactReopenStatus.stdout, "exact reopen observer status").health?.pid === originalPid,
    "an exact devbox reopen unnecessarily recycled the Observer",
  );
  process.kill(hostPid, 0);

  // A source renderer launched from an existing Station pane must discard that
  // pane's runtime selectors before it can inspect a Host, layout, or hook path.
  devbox(["start"], "hostile inherited environment", {
    PATH: `${bunShimRoot}:${process.env.PATH ?? ""}`,
    STATION_DEVBOX_SMOKE_BUN_LOG: bunInvocationLog,
    STATION_DEVBOX_SMOKE_REAL_BUN: resolvedBun.stdout.trim(),
    STATION_DEVBOX_SMOKE_CAPTURE_RENDERER_ENV: "1",
    STATION_DEVBOX_SMOKE_RENDERER_ENV_LOG: rendererEnvironmentLog,
    STATION_HOST_SOCKET_PATH: "/tmp/another-station-host.sock",
    STATION_LAYOUT_PATH: "/tmp/another-station-layout.json",
    STATION_HOST_HANDOFF: "1",
    STATION_CLIENT_BUILD_VERSION: "another-checkout-client",
    STATION_OBSERVER_BUILD_VERSION: "another-checkout-observer",
    STATION_SOURCE: "mock",
    STATION_SCENARIO: "disconnected",
    STATION_HOOK_SPOOL_DIR: "/tmp/another-station-spool",
    STATION_OBSERVER_STATE_DIR: "/tmp/another-station-state",
    STATION_STATE_DIR: "/tmp/another-station-state",
    STATION_INGRESS_BIN: "/tmp/another-checkout/stn-ingress",
    STATION_CURSOR_HOOKS_PATH: "/tmp/another-cursor-hooks.json",
    STATION_UI_RUN_ID: "ui_outer",
    STATION_PROJECT_ID: "outer-project",
    STATION_WORKTREE_ID: "outer-worktree",
    STATION_SESSION_ID: "outer-session",
  });
  assertRendererEnvironment();
  process.kill(originalPid, 0);
  process.kill(hostPid, 0);

  chmodSync(observerSock, 0o000);
  socketRestricted = true;
  const blocked = spawnResult("node", [wrapper, "start"], {
    env: { ...process.env, STATION_ISOLATED_NO_LAUNCH: "1" },
  });
  assert(blocked.status === 1, `inaccessible devbox start exited ${blocked.status}`);
  assert(
    blocked.stderr.includes("OBSERVER_SOCKET_INACCESSIBLE"),
    `inaccessible devbox start hid the Observer diagnosis\n${blocked.stderr}`,
  );
  assert(
    blocked.stderr.includes('"phase": "inspection"') &&
      blocked.stderr.includes('"incumbentDisposition": "preserved"') &&
      blocked.stderr.includes("The Station Host and hosted agents were not targeted"),
    `inaccessible devbox start omitted exact activation state\n${blocked.stderr}`,
  );
  assert(
    blocked.stderr.includes("bun run station:devbox status") &&
      blocked.stderr.includes("bun run station:devbox start"),
    `inaccessible devbox start omitted recovery commands\n${blocked.stderr}`,
  );
  process.kill(originalPid, 0);
  process.kill(hostPid, 0);
  const blockedSocket = statSync(observerSock);
  assert(
    blockedSocket.dev === originalSocket.dev && blockedSocket.ino === originalSocket.ino,
    "inaccessible devbox start replaced the incumbent socket",
  );

  chmodSync(observerSock, 0o600);
  socketRestricted = false;
  devbox(["start"], "recovery start", { STATION_ISOLATED_NO_LAUNCH: "1" });
  const recoveredStatus = spawnChecked("node", [cli, "--config", cfg, "observer", "status"], {
    label: "recovered isolated observer status",
    env: sourceCliEnv(),
  });
  assert(
    parseJson(recoveredStatus.stdout, "recovered isolated observer status").health?.pid ===
      originalPid,
    "restoring socket access did not reconnect to the original devbox Observer",
  );

  const recoveredHealth = parseJson(
    recoveredStatus.stdout,
    "recovered isolated observer status",
  ).health;
  const requestedVersion = recoveredHealth?.version;
  assert(typeof requestedVersion === "string", "recovered Observer omitted its build selector");
  const differentVersion = differentBuildSelector(requestedVersion);
  spawnChecked("node", [cli, "--config", cfg, "observer", "stop"], {
    label: "stop exact Observer before changed-build start",
    env: sourceCliEnv(),
  });
  await waitForPathAbsent(observerSock, "exact Observer socket");
  const alternateObserver = spawn(
    process.execPath,
    [
      join(repoRoot, "tests", "support", "observerMain.js"),
      "--socket",
      observerSock,
      "--state-dir",
      join(ds, "observer"),
      "--startup-timeout-ms",
      "10000",
      "--build-version",
      differentVersion,
      "--process-token",
      randomUUID(),
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: { ...sourceCliEnv(), STATION_TEST_REPO_ROOT: repoRoot },
    },
  );
  alternateObserver.unref();
  alternateObserverPid = alternateObserver.pid;
  assert(Number.isInteger(alternateObserverPid), "failed to launch different-build incumbent");
  await waitForPath(observerSock, "different-build Observer socket");

  const changedBuildStart = devbox(["start"], "changed-build start", {
    STATION_ISOLATED_NO_LAUNCH: "1",
  });
  assert(
    changedBuildStart.stdout.includes("Checkout build changed"),
    `start did not report exact-build replacement\n${changedBuildStart.stdout}`,
  );
  await waitForProcessExit(alternateObserverPid, "different-build incumbent");
  alternateObserverPid = undefined;
  const restartedStatus = spawnChecked("node", [cli, "--config", cfg, "observer", "status"], {
    label: "changed-build start observer status",
    env: sourceCliEnv(),
  });
  assert(
    parseJson(restartedStatus.stdout, "changed-build start observer status").health?.version ===
      requestedVersion,
    "devbox start did not activate this checkout's exact Observer build",
  );
  assertHookDoctors("changed-build start");
  assertCodexHookDelivery();
  process.kill(hostPid, 0);

  // stop removes the isolated observer + host sockets (teardown scoped to .dev-state).
  devbox(["stop"], "stop");
  assert(!existsSync(observerSock), `stop did not remove ${observerSock}`);
  assert(!existsSync(hostSock), `stop did not remove ${hostSock}`);

  process.stdout.write(
    `${JSON.stringify({ status: "station:devbox smoke passed", devboxState: ds }, null, 2)}\n`,
  );
} catch (error) {
  // Best-effort teardown so a failed assertion never leaves the observer running.
  if (socketRestricted) chmodSync(observerSock, 0o600);
  if (alternateObserverPid !== undefined) process.kill(alternateObserverPid, "SIGKILL");
  spawnSync("node", [wrapper, "stop"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
  throw error;
} finally {
  rmSync(bunShimRoot, { recursive: true, force: true });
}

async function waitForPath(path, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} was not created at ${path}`);
}

async function waitForPathAbsent(path, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} remained at ${path}`);
}

async function waitForProcessExit(pid, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} PID ${pid} remained alive`);
}

function parseArgs(args) {
  const parsed = { skipBuild: false };
  for (const arg of args) {
    if (arg === "--" || arg === "") {
      continue;
    }
    if (arg === "--skip-build") {
      parsed.skipBuild = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: bun run station:devbox:smoke [-- --skip-build]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown station:devbox smoke option: ${arg}`);
    }
  }
  return parsed;
}

function devbox(args, label, extraEnv) {
  return spawnChecked("node", [wrapper, ...args], {
    label: `station:devbox ${label}`,
    ...(extraEnv === undefined ? {} : { env: { ...process.env, ...extraEnv } }),
  });
}

function assertNoGlobalLeak(output, label) {
  assert(
    !output.includes(globalStateFragment),
    `${label} leaked the global state dir (${globalStateFragment}); it must stay on .dev-state\n${output}`,
  );
}

function assertRendererEnvironment() {
  const environment = Object.fromEntries(
    readFileSync(rendererEnvironmentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const equals = line.indexOf("=");
        return [line.slice(0, equals), line.slice(equals + 1)];
      }),
  );
  const expected = {
    STATION_SOURCE: "observer",
    STATION_SCENARIO: "__ABSENT__",
    STATION_HOST_SOCKET_PATH: hostSock,
    STATION_LAYOUT_PATH: join(ds, "station", "layout.json"),
    STATION_OBSERVER_SOCKET_PATH: observerSock,
    STATION_CONFIG_PATH: cfg,
    STATION_OBSERVER_STATE_DIR: join(ds, "observer"),
    STATION_STATE_DIR: "__ABSENT__",
    STATION_HOOK_SPOOL_DIR: join(ds, "observer", "spool", "hooks"),
    STATION_INGRESS_BIN: join(repoRoot, "bin", "stn-ingress"),
    STATION_HOST_HANDOFF: "__ABSENT__",
    STATION_CLIENT_BUILD_VERSION: "__ABSENT__",
    STATION_OBSERVER_BUILD_VERSION: "__ABSENT__",
    STATION_UI_RUN_ID: "__ABSENT__",
    STATION_PROJECT_ID: "__ABSENT__",
    STATION_WORKTREE_ID: "__ABSENT__",
    STATION_SESSION_ID: "__ABSENT__",
    STATION_CURSOR_HOOKS_PATH: "__ABSENT__",
  };
  assert(
    JSON.stringify(environment) === JSON.stringify(expected),
    `renderer environment escaped devbox isolation\nexpected=${JSON.stringify(expected, null, 2)}\nactual=${JSON.stringify(environment, null, 2)}`,
  );
}

function differentBuildSelector(version) {
  const replacement = version.endsWith("f") ? "e" : "f";
  return `${version.slice(0, -1)}${replacement}`;
}

function assertHookDoctors(label) {
  for (const provider of ["codex", "claude", "cursor", "opencode"]) {
    const result = spawnChecked("node", [cli, "--config", cfg, "hooks", "doctor", provider], {
      label: `${label} ${provider} hook doctor`,
      env: {
        ...sourceCliEnv(),
        CLAUDE_CONFIG_DIR: join(ds, "claude-home"),
        CODEX_HOME: join(ds, "codex-home"),
        OPENCODE_CONFIG_DIR: join(ds, "opencode-config"),
        STATION_CURSOR_HOME: join(ds, "cursor-home"),
      },
    });
    const doctor = parseJson(result.stdout, `${label} ${provider} hook doctor`);
    assert(
      doctor.status === "ok" && doctor.installed === true,
      `${label} left ${provider} hooks unhealthy\n${result.stdout}`,
    );
  }
}

function assertCodexHookDelivery() {
  assert(existsSync(codexHookScript), `Codex hook script missing at ${codexHookScript}`);
  const recordsBefore = readJsonl(hookLog).length;
  const payload = JSON.stringify({
    session_id: `devbox-smoke-${process.pid}`,
    transcript_path: null,
    cwd: repoRoot,
    hook_event_name: "SessionStart",
    model: "gpt-5.6-sol",
    permission_mode: "bypassPermissions",
    source: "startup",
  });
  spawnChecked(codexHookScript, [], {
    label: "restarted Codex hook delivery",
    input: payload,
    env: {
      ...sourceCliEnv(),
      STATION_CONFIG_PATH: cfg,
      STATION_HOOK_SPOOL_DIR: join(ds, "observer", "spool", "hooks"),
      STATION_OBSERVER_SOCKET_PATH: observerSock,
      STATION_SESSION_ID: `devbox-smoke-session-${process.pid}`,
      STATION_STATE_DIR: join(ds, "observer"),
      STATION_WORKTREE_ID: `devbox-smoke-worktree-${process.pid}`,
      STATION_WORKTREE_PATH: repoRoot,
    },
  });
  const newRecords = readJsonl(hookLog).slice(recordsBefore);
  assert(
    newRecords.some(
      (record) =>
        record.provider === "codex" &&
        record.attributes?.status === "accepted" &&
        record.attributes?.event === "SessionStart",
    ),
    `Codex hook did not deliver to the restarted Observer\n${JSON.stringify(newRecords, null, 2)}`,
  );
}

function sourceCliEnv() {
  return { ...process.env };
}

function readBunInvocations() {
  if (!existsSync(bunInvocationLog)) return [];
  return readFileSync(bunInvocationLog, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\u001f").filter((argument) => argument.length > 0));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseJson(line, `${path}:${index + 1}`));
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${String(error)}\n${source}`);
  }
}

function spawnChecked(command, args, options) {
  const result = spawnResult(command, args, options);
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${options.label} failed with status ${result.status ?? "unknown"}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function spawnResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: options.env ?? process.env,
    input: options.input,
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
