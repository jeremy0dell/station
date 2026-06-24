#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmux = process.env.STATION_TMUX_BIN ?? "tmux";

const args = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
const dryRun = args.has("--dry-run");
const skipOpen = args.has("--no-open");

const globalOptions = [
  "@station_popup_client",
  "@station_popup_focus_client",
  "@station_popup_ui_session_name",
  "@station_popup_ui_expected_signature",
  "@station_popup_ui_root",
  "@station_tui_dev_command",
  "@station_tui_dev_owner",
  "@station_tui_dev_root",
  "@station_tui_dev_session_name",
];

const tuiSessions = ["_station-ui", defaultDevSessionNameForRoot(repoRoot)];

main();

function main() {
  for (const arg of args) {
    if (arg !== "--dry-run" && arg !== "--no-open" && arg !== "--help") {
      fail(`Unknown option: ${arg}`);
    }
  }
  if (args.has("--help")) {
    printUsage();
    return;
  }

  ensureMainCheckout();
  run("git", ["fetch", "origin", "main"]);
  run("git", ["pull", "--ff-only", "origin", "main"]);
  resetTmuxTuiState();
  run("pnpm", ["build"]);
  run("pnpm", ["stn", "observer", "restart"]);
  if (!skipOpen) {
    run("pnpm", ["stn"]);
  }
}

function ensureMainCheckout() {
  const branch = read("git", ["branch", "--show-current"]).trim();
  if (branch !== "main") {
    fail(`station tmux TUI reset must run from main; current branch is ${branch || "(detached)"}.`);
  }
  const status = read("git", ["status", "--porcelain"]);
  if (status.trim().length > 0) {
    if (dryRun) {
      process.stdout.write(
        "Dry-run: checkout is dirty; real reset would stop before pulling main.\n",
      );
      return;
    }
    fail("station tmux TUI reset requires a clean checkout before pulling main.");
  }
}

function resetTmuxTuiState() {
  if (!isInsideTmux(process.env) && process.env.STATION_RESET_TMUX !== "1") {
    process.stdout.write("Skipping tmux TUI cleanup because this shell is not inside tmux.\n");
    return;
  }

  for (const option of globalOptions) {
    run(tmux, ["set-option", "-gq", "-u", option], { ignoreFailure: true });
  }
  for (const session of tuiSessions) {
    run(tmux, ["kill-session", "-t", session], { ignoreFailure: true });
  }
}

function run(command, args, options = {}) {
  process.stdout.write(`$ ${[command, ...args].join(" ")}\n`);
  if (dryRun) {
    return;
  }
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.ignoreFailure === true ? "ignore" : "inherit",
    env: process.env,
  });
  const status = result.status ?? 1;
  if (status !== 0 && options.ignoreFailure !== true) {
    process.exit(status);
  }
}

function read(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    process.exit(status);
  }
  return result.stdout;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function isInsideTmux(env) {
  return env.TMUX !== undefined && env.TMUX.length > 0;
}

function defaultDevSessionNameForRoot(root) {
  const slug = basename(root)
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `_station-ui-dev-${slug.length === 0 ? "checkout" : slug}-${hash}`;
}

function printUsage() {
  process.stdout.write(`Usage: pnpm station:reset:tmux-tui [-- --dry-run] [-- --no-open]

Pulls main, clears only tmux TUI/popup state, rebuilds, restarts the observer,
then opens station from the rebuilt checkout.

Options:
  --dry-run    print the actions without running them
  --no-open    stop after observer restart instead of opening station
`);
}
