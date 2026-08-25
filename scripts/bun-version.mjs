#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUN_PACKAGE_MANAGER_PATTERN =
  /^bun@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u;
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** Reads the repository's exact Bun policy from the root packageManager field. */
export async function requiredBunVersion(root = repoRoot) {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const packageManager = manifest?.packageManager;
  const match =
    typeof packageManager === "string" ? BUN_PACKAGE_MANAGER_PATTERN.exec(packageManager) : null;
  const version = match?.[1];
  if (version === undefined) {
    throw new Error('Root package.json must declare packageManager as exact "bun@<version>".');
  }
  return version;
}

function bunExecutableNames() {
  return process.platform === "win32" ? ["bun.exe", "bun.cmd", "bun"] : ["bun"];
}

function bunPathDirectories(options) {
  const environment = options.env ?? process.env;
  const path = environment.PATH;
  if (typeof path !== "string") {
    throw new Error("Bun is not available because PATH is unset.");
  }
  const cwd = options.cwd ?? process.cwd();
  return path.split(delimiter).map((entry) => (entry.length === 0 ? cwd : resolve(cwd, entry)));
}

async function resolveBunCandidate(candidate) {
  await access(candidate, constants.X_OK);
  const executable = await realpath(candidate);
  if (!(await stat(executable)).isFile()) return undefined;
  return executable;
}

/** Resolves one PATH Bun into its canonical executable and verified bare-command directory. */
export async function resolveBunRuntime(options = {}) {
  for (const directory of bunPathDirectories(options)) {
    for (const name of bunExecutableNames()) {
      const candidate = join(directory, name);
      try {
        const executable = await resolveBunCandidate(candidate);
        if (executable !== undefined) return { executable, locatorDirectory: directory };
      } catch {
        // Continue through PATH exactly as process spawning would.
      }
    }
  }
  throw new Error("Bun is not available on PATH.");
}

/** Resolves the bare-command directory that points to one already-running Bun executable. */
export async function locateBunRuntime(bunExecutable, options = {}) {
  if (!isAbsolute(bunExecutable)) {
    throw new Error(`Bun executable must be absolute: ${bunExecutable}`);
  }
  const executable = await resolveBunCandidate(bunExecutable);
  if (executable === undefined) {
    throw new Error(`Bun executable is not a regular file: ${bunExecutable}`);
  }
  for (const directory of bunPathDirectories(options)) {
    for (const name of bunExecutableNames()) {
      try {
        if ((await resolveBunCandidate(join(directory, name))) === executable) {
          return { executable, locatorDirectory: directory };
        }
      } catch {
        // A different or unavailable PATH candidate cannot anchor this exact runtime.
      }
    }
  }
  if (bunExecutableNames().includes(basename(executable))) {
    return { executable, locatorDirectory: dirname(executable) };
  }
  throw new Error(
    `Exact Bun executable has no matching bare-command locator on PATH: ${executable}`,
  );
}

/** Resolves Bun through one PATH snapshot and returns its canonical absolute executable. */
export async function resolveBunExecutable(options = {}) {
  return (await resolveBunRuntime(options)).executable;
}

/** Anchors nested bare-Bun dispatch to the verified locator for one admitted executable. */
export function environmentWithBunRuntime(runtime, environment = process.env) {
  if (!isAbsolute(runtime.executable)) {
    throw new Error(`Bun executable must be absolute: ${runtime.executable}`);
  }
  if (!isAbsolute(runtime.locatorDirectory)) {
    throw new Error(`Bun locator directory must be absolute: ${runtime.locatorDirectory}`);
  }
  const path = environment.PATH ?? "";
  return {
    ...environment,
    PATH:
      path.length === 0
        ? runtime.locatorDirectory
        : `${runtime.locatorDirectory}${delimiter}${path}`,
  };
}

/** Rejects a runtime that differs from the root packageManager policy. */
export function assertBunVersion(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Station requires Bun ${expected}; found ${actual}.`);
  }
}

/** Resolves and checks one Bun executable against the root packageManager policy. */
export async function resolveAndCheckBunVersion(root = repoRoot, options = {}) {
  const expected = await requiredBunVersion(root);
  let runtime;
  let actual;
  try {
    const runtimeOptions = {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? { cwd: root } : { cwd: options.cwd }),
    };
    runtime =
      options.executable === undefined
        ? await resolveBunRuntime(runtimeOptions)
        : await locateBunRuntime(options.executable, runtimeOptions);
    actual = execFileSync(runtime.executable, ["--version"], {
      cwd: options.cwd ?? root,
      encoding: "utf8",
      ...(options.env === undefined ? {} : { env: options.env }),
    }).trim();
  } catch (error) {
    throw new Error(`Station requires Bun ${expected}, but Bun could not be resolved and run.`, {
      cause: error,
    });
  }
  assertBunVersion(actual, expected);
  return { ...runtime, version: expected };
}

/** Checks the Bun executable on PATH against the root packageManager policy. */
export async function checkBunVersion(root = repoRoot, options = {}) {
  return (await resolveAndCheckBunVersion(root, options)).version;
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
