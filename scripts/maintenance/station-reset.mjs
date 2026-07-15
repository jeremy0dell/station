#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmux = process.env.STATION_TMUX_BIN ?? "tmux";

const globalOptions = [
  "@station_popup_client",
  "@station_popup_focus_client",
  "@station_popup_active_claim",
  "@station_popup_ui_route",
  "@station_popup_ui_session_name",
  "@station_popup_ui_expected_signature",
  "@station_popup_ui_root",
  "@station_tui_dev_command",
  "@station_tui_dev_owner",
  "@station_tui_dev_root",
  "@station_tui_dev_session_name",
];

const sessions = ["_station-ui", defaultDevSessionNameForRoot(repoRoot)];

if (isInsideTmux(process.env) || process.env.STATION_RESET_TMUX === "1") {
  for (const option of globalOptions) {
    spawnSync(tmux, ["set-option", "-gq", "-u", option], {
      cwd: repoRoot,
      stdio: "ignore",
      env: process.env,
    });
  }
  for (const session of sessions) {
    spawnSync(tmux, ["kill-session", "-t", session], {
      cwd: repoRoot,
      stdio: "ignore",
      env: process.env,
    });
  }
}

const restart = spawnSync("pnpm", ["stn", "observer", "restart"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

if ((restart.status ?? 1) !== 0) {
  process.exitCode = restart.status ?? 1;
  process.exit();
}

const result = spawnSync("pnpm", ["stn"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

process.exitCode = result.status ?? 1;

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
