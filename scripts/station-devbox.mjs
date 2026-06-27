#!/usr/bin/env node
// Root entrypoint for the isolated Station devbox. A thin delegator over the
// existing isolated path (station/.../station:isolated) so
// the whole sandbox lifecycle is one command from any checkout/worktree root.
// Repo root is resolved from THIS script's own location, so a worktree root
// targets its own .dev-state, never the main checkout's.
import { spawnSync } from "node:child_process";
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

const handlers = { start, dev, restart, status, logs, stop, reset, help };

const [rawVerb = "start", ...rest] = process.argv.slice(2);
const verb =
  rawVerb === "-h" || rawVerb === "--help" ? "help" : rawVerb === "--hot" ? "dev" : rawVerb;
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

function start() {
  // Always build (Turbo-cached when clean) so the observer/CLI and the dist the
  // Station UI links are never stale — `station:devbox` needs no separate build.
  run("pnpm", ["build"], { cwd: repoRoot });
  process.exit(run("bun", ["run", "station:isolated"], { cwd: STATION_DIR, check: false }));
}

function dev() {
  run("pnpm", ["build"], { cwd: repoRoot });
  process.exit(run("bun", ["run", "station:isolated", "dev"], { cwd: STATION_DIR, check: false }));
}

function restart() {
  requireConfig();
  log("Rebuilding (pnpm build)…");
  run("pnpm", ["build"], { cwd: repoRoot });
  log("Recycling the isolated observer (the persistent host + agents survive and reconnect)…");
  run("node", [CLI, "--config", CFG, "observer", "restart"], { cwd: repoRoot });
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
  }
  // Read-only: is a SEPARATE global observer running? Resolve it the way the CLI
  // does (honors ~/.config/station + XDG_RUNTIME_DIR). `observer status` only probes;
  // it never starts/stops/mutates the global observer.
  log("");
  log("global observer (separate, read-only):");
  run("node", [CLI, "observer", "status"], { cwd: repoRoot, check: false, env: globalEnv() });
}

function logs(args) {
  const follow = args.some((arg) => arg === "--follow" || arg === "-f");
  const files = ["observer.jsonl", "station-host.jsonl", "cli.jsonl"]
    .map((file) => join(LOG_DIR, file))
    .filter(existsSync);
  if (files.length === 0) {
    log(`No devbox logs under ${LOG_DIR} — has it been started? (pnpm station:devbox start)`);
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
        "  pnpm station:devbox reset -- --yes\n",
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
      "Usage: pnpm station:devbox [start|dev|restart|status|logs|stop|reset]",
      "",
      "  start            (default) build if needed, then start the isolated Station sandbox",
      "  dev, --hot       build if needed, then start the isolated Station sandbox with UI HMR",
      "  restart          rebuild + recycle the isolated observer (persistent host/agents survive)",
      "  status           report the isolated observer/host + (read-only) the global observer",
      "  logs [--follow]  tail the isolated observer/host/cli logs",
      "  stop             stop the isolated observer + host (preserves .dev-state for reattach)",
      "  reset --yes      stop, then delete .dev-state for this checkout",
      "",
    ].join("\n"),
  );
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
    throw new Error("devbox not started — run `pnpm station:devbox start` first.");
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
