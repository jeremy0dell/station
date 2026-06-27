#!/usr/bin/env node
// Scripted smoke for the root `pnpm station:devbox` wrapper. Uses the no-UI seam
// (STATION_ISOLATED_NO_LAUNCH=1) to start the isolated observer without the TUI,
// then proves the wrapper targets this checkout's .dev-state (not global state)
// and tears it down. Kept out of pnpm test:all (needs the Station Bun workspace).
//
// Warning: runs against the real .dev-state for this checkout — it starts and
// then STOPS the devbox, so a live devbox here will be stopped.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const options = parseArgs(process.argv.slice(2));
const timeoutMs = Number(process.env.STATION_DEVBOX_SMOKE_TIMEOUT_MS ?? 180_000);

const wrapper = join(repoRoot, "scripts", "station-devbox.mjs");
const cli = join(repoRoot, "apps", "cli", "dist", "main.js");
const ds = join(repoRoot, ".dev-state");
const cfg = join(ds, "config.toml");
const observerSock = join(ds, "observer", "run", "observer.sock");
const hostSock = join(ds, "observer", "run", "station-host.sock");
const hooksDir = join(ds, "observer", "hooks");
const globalStateFragment = join(".local", "state", "station");

process.stderr.write(
  "station:devbox smoke — starts and STOPS this checkout's devbox (.dev-state).\n",
);

try {
  if (!options.skipBuild) {
    spawnChecked("pnpm", ["build"], { label: "build" });
  } else {
    assert(existsSync(cli), "built CLI is missing; run pnpm build or omit --skip-build");
  }

  // Start via the no-UI seam: the wrapper delegates to the isolated path, which
  // brings up the observer + installs codex/claude hooks, then exits (no TUI).
  const start = devbox(["start"], "start", { STATION_ISOLATED_NO_LAUNCH: "1" });
  assert(
    start.stdout.includes(observerSock),
    `start did not report the isolated observer socket ${observerSock}\n${start.stdout}`,
  );
  assertNoGlobalLeak(start.stdout, "start");
  assert(existsSync(observerSock), `isolated observer socket not created at ${observerSock}`);

  // Claude parity: the isolated hook install must land artifacts under .dev-state.
  const claudeArtifacts = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter((file) => file.includes("claude"))
    : [];
  assert(
    claudeArtifacts.length > 0,
    `no isolated Claude hook artifacts under ${hooksDir} — claude parity install did not run`,
  );

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

  // stop removes the isolated observer + host sockets (teardown scoped to .dev-state).
  devbox(["stop"], "stop");
  assert(!existsSync(observerSock), `stop did not remove ${observerSock}`);
  assert(!existsSync(hostSock), `stop did not remove ${hostSock}`);

  process.stdout.write(
    `${JSON.stringify(
      { status: "station:devbox smoke passed", devboxState: ds, claudeArtifacts },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  // Best-effort teardown so a failed assertion never leaves the observer running.
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

function spawnChecked(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: options.env ?? process.env,
  });
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
