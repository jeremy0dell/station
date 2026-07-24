#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyChangedPaths, DOCUMENTATION_ONLY_SCOPE } from "./ci/change-scope.mjs";

function runFullGate() {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, ["test:pre-push"], { stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.status ?? 1;
}

function main() {
  const scope = classifyChangedPaths(process.argv.slice(2));
  if (scope === DOCUMENTATION_ONLY_SCOPE) {
    process.stdout.write("Documentation-only push; skipping pnpm test:pre-push.\n");
    return;
  }
  runFullGate();
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  main();
}
