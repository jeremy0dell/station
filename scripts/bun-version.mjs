#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUN_PACKAGE_MANAGER_PATTERN =
  /^bun@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u;
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** Reads the repository's exact Bun policy from the root packageManager field. */
export async function requiredBunVersion(root = repoRoot) {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const match = BUN_PACKAGE_MANAGER_PATTERN.exec(manifest.packageManager);
  const version = match?.[1];
  if (version === undefined) {
    throw new Error('Root package.json must declare packageManager as exact "bun@<version>".');
  }
  return version;
}

/** Rejects a runtime that differs from the root packageManager policy. */
export function assertBunVersion(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Station requires Bun ${expected}; found ${actual}.`);
  }
}

/** Checks the Bun executable on PATH against the root packageManager policy. */
export async function checkBunVersion(root = repoRoot) {
  const expected = await requiredBunVersion(root);
  let actual;
  try {
    actual = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`Station requires Bun ${expected}, but bun is not available on PATH.`, {
      cause: error,
    });
  }
  assertBunVersion(actual, expected);
  return expected;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0 || (args.length === 1 && args[0] === "--check")) {
      await checkBunVersion();
    } else if (args.length === 1 && args[0] === "--print") {
      process.stdout.write(`${await requiredBunVersion()}\n`);
    } else {
      throw new Error("Usage: bun-version.mjs [--check|--print]");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
