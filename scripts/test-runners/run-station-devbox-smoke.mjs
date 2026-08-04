#!/usr/bin/env node
// Scripted smoke for the root `pnpm station:devbox` wrapper. Uses the no-UI seam
// (STATION_ISOLATED_NO_LAUNCH=1) to start the isolated observer without the TUI,
// then proves the wrapper targets this checkout's .dev-state (not global state)
// and tears it down. Kept out of pnpm test:all (needs the Station Bun workspace).
//
// Warning: runs against the real .dev-state for this checkout — it starts and
// then STOPS the devbox, so a live devbox here will be stopped.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
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
const hooksDir = join(ds, "observer", "hooks");
const hookLog = join(ds, "observer", "logs", "hooks.jsonl");
const codexHookScript = join(hooksDir, "station-codex-hook.sh");
const codexProfileConfig = join(ds, "codex-home", "station.config.toml");
const globalStateFragment = join(".local", "state", "station");
let socketRestricted = false;

process.stderr.write(
  "station:devbox smoke — starts and STOPS this checkout's devbox (.dev-state).\n",
);

try {
  if (!options.skipBuild) {
    spawnChecked("pnpm", ["build"], { label: "build" });
  } else {
    assert(existsSync(cli), "built CLI is missing; run pnpm build or omit --skip-build");
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
  const start = devbox(["start"], "start", { STATION_ISOLATED_NO_LAUNCH: "1" });
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

  // status through the wrapper reports the isolated socket; the direct isolated
  // observer status must not leak the global state dir.
  const status = devbox(["status"], "status");
  assert(
    status.stdout.includes(observerSock),
    `wrapper status did not report the isolated socket\n${status.stdout}`,
  );
  const isoStatus = spawnChecked("node", [cli, "--config", cfg, "observer", "status"], {
    label: "isolated observer status",
  });
  assertNoGlobalLeak(isoStatus.stdout, "isolated observer status");
  const healthyStatus = parseJson(isoStatus.stdout, "isolated observer status");
  const originalPid = healthyStatus.health?.pid;
  assert(
    Number.isInteger(originalPid),
    `isolated status did not report a PID\n${isoStatus.stdout}`,
  );
  const originalSocket = statSync(observerSock);

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
    blocked.stderr.includes("The isolated Observer and .dev-state were preserved."),
    `inaccessible devbox start omitted preservation guidance\n${blocked.stderr}`,
  );
  assert(
    blocked.stderr.includes("pnpm station:devbox status") &&
      blocked.stderr.includes("pnpm station:devbox start"),
    `inaccessible devbox start omitted recovery commands\n${blocked.stderr}`,
  );
  process.kill(originalPid, 0);
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
  });
  assert(
    parseJson(recoveredStatus.stdout, "recovered isolated observer status").health?.pid ===
      originalPid,
    "restoring socket access did not reconnect to the original devbox Observer",
  );

  devbox(["restart"], "restart");
  const restartedStatus = spawnChecked("node", [cli, "--config", cfg, "observer", "status"], {
    label: "restarted isolated observer status",
  });
  assert(
    parseJson(restartedStatus.stdout, "restarted isolated observer status").health?.pid !==
      originalPid,
    "devbox restart did not replace the isolated Observer",
  );
  assertHookDoctors("restart");
  assertCodexHookDelivery();

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
  spawnSync("node", [wrapper, "stop"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
  throw error;
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
      process.stdout.write("Usage: pnpm station:devbox:smoke [-- --skip-build]\n");
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

function assertHookDoctors(label) {
  for (const provider of ["codex", "claude", "cursor", "opencode"]) {
    const result = spawnChecked("node", [cli, "--config", cfg, "hooks", "doctor", provider], {
      label: `${label} ${provider} hook doctor`,
      env: {
        ...process.env,
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
      ...process.env,
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
        record.attributes?.status === "ingested" &&
        record.attributes?.event === "SessionStart",
    ),
    `Codex hook did not deliver to the restarted Observer\n${JSON.stringify(newRecords, null, 2)}`,
  );
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
