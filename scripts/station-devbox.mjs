#!/usr/bin/env node
// Root entrypoint for the isolated Station devbox. A thin delegator over the
// existing isolated path (station/.../station:isolated) so
// the whole sandbox lifecycle is one command from any checkout/worktree root.
// Repo root is resolved from THIS script's own location, so a worktree root
// targets its own .dev-state, never the main checkout's.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DS = join(repoRoot, ".dev-state");
const CFG = join(DS, "config.toml");
const CLI = join(repoRoot, "apps", "cli", "dist", "main.js");
const SOCKET_DIR = join(
  tmpdir(),
  `stn-db-${createHash("sha256").update(repoRoot).digest("hex").slice(0, 12)}`,
);
const HOST_SOCK = join(SOCKET_DIR, "station-host.sock");
const LOG_DIR = join(DS, "observer", "logs");
const STATION_DIR = join(repoRoot, "station");
const ISOLATED_SCRIPT = join(repoRoot, "station", "scripts", "station-isolated.sh");
const BACKEND_SCRIPTS = new Map([["tmux", join(repoRoot, "scripts", "station-tmux-devbox.mjs")]]);

const handlers = { start, dev, restart, status, logs, stop, reset, help };

const [rawVerb = "start", ...rest] = process.argv.slice(2);
let verb = rawVerb;
if (rawVerb === "-h" || rawVerb === "--help") {
  verb = "help";
} else if (rawVerb === "--hot") {
  verb = "dev";
}
const backendScript = BACKEND_SCRIPTS.get(verb);
if (backendScript !== undefined) {
  try {
    process.exitCode = await delegateBackend(backendScript, rest);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  const handler = handlers[verb];
  if (handler === undefined) {
    process.stderr.write(`Unknown station:devbox command: ${verb}\n\n`);
    help();
    process.exit(1);
  }
  try {
    handler(rest);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function start() {
  // Always build (Turbo-cached when clean) so the observer/CLI and the dist the
  // Station UI links are never stale — `station:devbox` needs no separate build.
  run("bun", ["run", "build"], { cwd: repoRoot });
  warnHostBuildMismatch();
  process.exit(run("bun", ["run", "station:isolated"], { cwd: STATION_DIR, check: false }));
}

function dev() {
  run("bun", ["run", "build"], { cwd: repoRoot });
  warnHostBuildMismatch();
  process.exit(run("bun", ["run", "station:isolated", "dev"], { cwd: STATION_DIR, check: false }));
}

function restart() {
  requireConfig();
  log("Rebuilding (bun run build)…");
  run("bun", ["run", "build"], { cwd: repoRoot });
  log("Recycling the isolated observer (the persistent host + agents survive and reconnect)…");
  run("node", [CLI, "--config", CFG, "observer", "stop"], { cwd: repoRoot });
  run("bash", [ISOLATED_SCRIPT, "start"], {
    cwd: repoRoot,
    env: { ...process.env, STATION_ISOLATED_NO_LAUNCH: "1" },
  });
  warnHostBuildMismatch();
  log(
    "Done. If you changed the station host (hostMain.ts), run `stop` then `start` to recycle it.",
  );
}

function status() {
  log(`devbox root:   ${repoRoot}`);
  if (!existsSync(CFG)) {
    log(`devbox state:  not started (no ${CFG})`);
  } else {
    log(`devbox config: ${CFG}`);
    run("node", [CLI, "--config", CFG, "observer", "status"], { cwd: repoRoot, check: false });
    log(
      `host socket:   ${
        existsSync(HOST_SOCK) ? `present (${HOST_SOCK})` : "absent — no persistent host running"
      }`,
    );
    log(
      `               live agents: bun run --cwd ${STATION_DIR} host:list -- --socket ${HOST_SOCK}`,
    );
    warnHostBuildMismatch();
  }
  // Read-only: is a SEPARATE global observer running? Resolve it the way the CLI
  // does (honors ~/.config/station + XDG_RUNTIME_DIR). `observer status` only probes;
  // it never starts/stops/mutates the global observer.
  log("");
  log("global observer (separate, read-only):");
  run("node", [CLI, "observer", "status"], { cwd: repoRoot, check: false, env: globalEnv() });
}

/**
 * Devbox always launches a Bun source host. Warn when a listening host's build
 * does not match this checkout CLI (replace/refuse), e.g. after a binary handoff.
 */
function warnHostBuildMismatch() {
  if (!existsSync(CFG) || !existsSync(HOST_SOCK) || !existsSync(CLI)) {
    return;
  }
  const result = spawnSync(process.execPath, [CLI, "--config", CFG, "host", "status"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!/compatibility:\s*(replace|refuse)/u.test(output)) {
    return;
  }
  log("");
  log("WARNING: host build mismatch for this station:devbox lane.");
  log("  Devbox always launches a Bun source host (STATION_HOST_ENTRY=hostMain.ts).");
  log(
    "  The listening host is not this checkout CLI's expected build (compatibility replace/refuse).",
  );
  log("  Run `bun run station:devbox stop` then `start` to recycle the host, or deliberately");
  log(
    "  `bun run stn -- --config .dev-state/config.toml host handoff` only if you intend to change packaging.",
  );
  const healthLine = output
    .split("\n")
    .find((line) => line.startsWith("health:") || line.startsWith("compatibility:"));
  if (healthLine !== undefined) {
    log(`  (${healthLine.trim()})`);
  }
}

function logs(args) {
  const follow = args.some((arg) => arg === "--follow" || arg === "-f");
  const files = ["observer.jsonl", "station-host.jsonl", "cli.jsonl"]
    .map((file) => join(LOG_DIR, file))
    .filter(existsSync);
  if (files.length === 0) {
    log(`No devbox logs under ${LOG_DIR} — has it been started? (bun run station:devbox start)`);
    return;
  }
  log(`Logs (${LOG_DIR}):`);
  for (const file of files) {
    log(`  ${file}`);
  }
  log("");
  run("tail", follow ? ["-f", ...files] : ["-n", "40", ...files], { cwd: repoRoot, check: false });
}

function stop() {
  // station-isolated.sh stop scopes its teardown to this worktree's .dev-state.
  run("bash", [ISOLATED_SCRIPT, "stop"], { cwd: repoRoot, check: false });
  log(`.dev-state preserved at ${DS} — next start reattaches. Use 'reset --yes' to wipe it.`);
}

function reset(args) {
  // Guarded: this deletes the isolated observer DB, diagnostics, hook artifacts,
  // isolated provider homes, and any reattachable host state.
  if (!args.some((arg) => arg === "--yes" || arg === "-y")) {
    process.stderr.write(
      `Refusing to reset without --yes. This deletes everything under ${DS}.\n\n` +
        "  bun run station:devbox reset -- --yes\n",
    );
    process.exit(1);
  }
  run("bash", [ISOLATED_SCRIPT, "stop"], { cwd: repoRoot, check: false });
  rmSync(DS, { recursive: true, force: true });
  log(`Removed ${DS}.`);
}

function help() {
  process.stdout.write(
    [
      "Usage: bun run station:devbox [start|dev|restart|status|logs|stop|reset]",
      "",
      "  start            (default) build, sync the isolated Observer to this checkout, then open Station",
      "  dev, --hot       build, sync the isolated Observer to this checkout, then open with UI HMR",
      "  restart          rebuild + recycle the isolated observer (persistent host/agents survive)",
      "  status           report the isolated observer/host (+ host build mismatch warning) and global observer",
      "  logs [--follow]  tail the isolated observer/host/cli logs",
      "  stop             stop the isolated observer + host (preserves .dev-state for reattach)",
      "  reset --yes      stop, then delete .dev-state for this checkout",
      "  tmux ...         private checkout-keyed tmux popup devbox (run `tmux help`)",
      "",
    ].join("\n"),
  );
}

async function delegateBackend(backendScript, args) {
  // Backend scripts retain backend-specific process and cleanup authority; this router only delegates.
  const child = spawn(process.execPath, [backendScript, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
    const handler = () => child.kill(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code !== null) {
          resolve(code);
          return;
        }
        resolve(signalExitCode(signal));
      });
    });
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  }
}

function signalExitCode(signal) {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    default:
      return 143;
  }
}

function run(command, args, options = {}) {
  const { check = true, cwd = repoRoot, env = process.env } = options;
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error;
  }
  const code = result.status ?? 1;
  if (check && code !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed (exit ${code})`);
  }
  return code;
}

function requireConfig() {
  if (!existsSync(CFG)) {
    throw new Error("devbox not started — run `bun run station:devbox start` first.");
  }
}

function globalEnv() {
  // Strip the isolated Station env so the global probe resolves the real default.
  const env = { ...process.env };
  delete env.STATION_OBSERVER_SOCKET_PATH;
  delete env.STATION_CONFIG_PATH;
  return env;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}
