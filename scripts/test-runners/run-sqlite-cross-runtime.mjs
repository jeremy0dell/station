import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const probePath = join(repoRoot, "scripts", "test-runners", "sqlite-runtime-probe.mjs");
const tempRoot = mkdtempSync(join(tmpdir(), "station-sqlite-cross-runtime-"));

try {
  runProbe("node", "seed-v16", join(tempRoot, "node-created.sqlite"), "created-by-node");
  runProbe("bun", "upgrade-write", join(tempRoot, "node-created.sqlite"), "created-by-node");
  runProbe("node", "read", join(tempRoot, "node-created.sqlite"), "created-by-node");
  runProbe("bun", "seed-v16", join(tempRoot, "bun-created.sqlite"), "created-by-bun");
  runProbe("node", "upgrade-write", join(tempRoot, "bun-created.sqlite"), "created-by-bun");
  runProbe("bun", "read", join(tempRoot, "bun-created.sqlite"), "created-by-bun");
  const compiledProbe = join(tempRoot, "sqlite-probe");
  const build = spawnSync("bun", ["build", probePath, "--compile", "--outfile", compiledProbe], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("Compiled SQLite probe build failed.");
  for (const [label, runtime] of [
    ["node", "node"],
    ["bun", "bun"],
    ["compiled", compiledProbe],
  ]) {
    for (const size of [1, 460]) {
      const stateDir = join(tempRoot, `${label}-${size}`);
      mkdirSync(stateDir, { mode: 0o700 });
      const args = ["backup", join(stateDir, "observer.sqlite"), String(size)];
      const result = spawnSync(runtime, label === "compiled" ? args : [probePath, ...args], {
        cwd: repoRoot,
        stdio: "inherit",
        timeout: 120_000,
      });
      if (result.status !== 0)
        throw new Error(`${label} ${size} MiB recovery backup probe failed.`);
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
  console.log("Cross-runtime SQLite compatibility passed for Node, Bun, and compiled Bun.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function runProbe(runtime, action, databasePath, label) {
  const result = spawnSync(runtime, [probePath, action, databasePath, label], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${runtime} SQLite ${action} probe exited with status ${result.status}.`);
  }
}
