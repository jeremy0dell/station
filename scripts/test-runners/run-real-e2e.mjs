#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2);
const keepTemp = takeFlag(args, "--keep-temp");
const vitestArgs = ["run", "--config", "config/vitest/vitest.real-e2e.config.ts", ...args];
const env = {
  ...process.env,
  STATION_REAL_E2E: "1",
  STATION_REAL_WORKTRUNK: "1",
  STATION_REAL_CODEX: "1",
  STATION_WORKTRUNK_BIN: process.env.STATION_WORKTRUNK_BIN ?? resolveCommand("wt"),
  STATION_TMUX_BIN: process.env.STATION_TMUX_BIN ?? resolveCommand("tmux"),
  STATION_CODEX_BIN: process.env.STATION_CODEX_BIN ?? resolveCommand("codex"),
  STATION_CLAUDE_BIN: process.env.STATION_CLAUDE_BIN ?? resolveCommand("claude"),
};
if (keepTemp) {
  env.STATION_REAL_E2E_KEEP_TEMP = "1";
}

const vitestBin = join(repoRoot, "node_modules", ".bin", "vitest");
const command = existsSync(vitestBin) ? vitestBin : "vitest";
const result = spawnSync(command, vitestArgs, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});

if (result.error !== undefined) {
  throw result.error;
}
process.exitCode = result.status ?? 1;

function takeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) {
    return false;
  }
  values.splice(index, 1);
  return true;
}

function resolveCommand(command) {
  const resolved = spawnSync("which", [command], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const path = resolved.stdout.trim();
  return path.length > 0 ? path : command;
}
