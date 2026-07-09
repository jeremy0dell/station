import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const probePath = join(repoRoot, "scripts", "test-runners", "sqlite-runtime-probe.mjs");
const tempRoot = mkdtempSync(join(tmpdir(), "station-sqlite-cross-runtime-"));

try {
  runProbe("node", "create", join(tempRoot, "node-created.sqlite"), "created-by-node");
  runProbe("bun", "read", join(tempRoot, "node-created.sqlite"), "created-by-node");
  runProbe("bun", "create", join(tempRoot, "bun-created.sqlite"), "created-by-bun");
  runProbe("node", "read", join(tempRoot, "bun-created.sqlite"), "created-by-bun");
  console.log("Cross-runtime SQLite compatibility passed for Node and Bun.");
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
