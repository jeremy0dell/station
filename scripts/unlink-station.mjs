#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const launcherTargets = {
  stn: join("bin", "stn"),
  "stn-ingress": join("bin", "stn-ingress"),
  "stn-tmux-popup": join("integrations", "terminal", "tmux", "bin", "stn-popup"),
};

/** Proves every Bun-global launcher still resolves to the checkout requesting unlink. */
export async function assertStationLauncherOwnership(root, globalBin) {
  const resolvedRoot = await realpath(root);
  for (const [launcher, target] of Object.entries(launcherTargets)) {
    let actual;
    let expected;
    try {
      [actual, expected] = await Promise.all([
        realpath(join(globalBin, launcher)),
        realpath(join(resolvedRoot, target)),
      ]);
    } catch (error) {
      throw new Error(
        `Refusing to unlink Station: global launcher ${launcher} is missing or unreadable.`,
        { cause: error },
      );
    }
    if (actual !== expected) {
      throw new Error(
        `Refusing to unlink Station: global launcher ${launcher} belongs to another checkout.`,
      );
    }
  }
}

/** Resolves the global launcher directory using the same Bun installation-prefix policy as `bun link`. */
export function resolveBunGlobalBin(environment, homeDirectory = homedir()) {
  if (environment.BUN_INSTALL_BIN !== undefined) return environment.BUN_INSTALL_BIN;
  const installRoot = environment.BUN_INSTALL ?? join(homeDirectory, ".bun");
  return join(installRoot, "bin");
}

async function main() {
  const globalBin = resolveBunGlobalBin(process.env);
  if (!isAbsolute(globalBin)) {
    throw new Error(`Bun returned an invalid global bin directory: ${globalBin || "(empty)"}.`);
  }
  await assertStationLauncherOwnership(repoRoot, globalBin);

  const unlink = spawnSync("bun", ["unlink"], { cwd: repoRoot, stdio: "inherit" });
  if (unlink.error !== undefined) throw unlink.error;
  if (unlink.status !== 0) {
    throw new Error(`bun unlink exited with code ${unlink.status ?? 1}.`);
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
