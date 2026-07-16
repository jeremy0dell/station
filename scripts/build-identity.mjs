#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, readlink, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUILD_IDENTITY_PATTERN = /^[0-9a-f]{64}$/u;
const BUILD_IDENTITY_DOMAIN = "station-build-identity-v1";
const BUILD_INPUT_IDENTITY_DOMAIN = "station-build-input-identity-v1";
const BUILD_OUTPUT_IDENTITY_DOMAIN = "station-build-output-identity-v1";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const gitLocalEnvironmentVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

export function buildIdentityPath(root = repoRoot) {
  return join(root, "packages", "runtime", "dist", "station-build-id");
}

/** Hashes repository inputs and production package outputs in stable byte order. */
export async function computeBuildIdentity(root = repoRoot) {
  const inputIdentity = await computeBuildInputIdentity(root);
  return computeBuildIdentityFromInput(inputIdentity, root);
}

async function computeBuildIdentityFromInput(inputIdentity, root) {
  const outputIdentity = await computeBuildOutputIdentity(root);
  const completedInputIdentity = await computeBuildInputIdentity(root);
  if (completedInputIdentity !== inputIdentity) {
    throw new Error(
      "Station build inputs changed while identity was being computed; retry from a stable checkout.",
    );
  }
  const hash = createHash("sha256");
  updateHashField(hash, "domain", BUILD_IDENTITY_DOMAIN);
  updateHashField(hash, "inputs", inputIdentity);
  updateHashField(hash, "outputs", outputIdentity);
  return hash.digest("hex");
}

async function computeBuildInputIdentity(root) {
  const head = (await runGit(root, ["rev-parse", "HEAD"])).toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(head)) {
    throw new Error(`Could not resolve a full Git HEAD for Station build identity: ${head}`);
  }

  const tracked = splitNullTerminated(await runGit(root, ["ls-files", "--cached", "-z"]));
  const untracked = splitNullTerminated(
    await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  const paths = [...new Set([...tracked, ...untracked])].sort(compareUtf8);
  const hash = createHash("sha256");
  updateHashField(hash, "domain", BUILD_INPUT_IDENTITY_DOMAIN);
  updateHashField(hash, "head", head);

  for (const path of paths) {
    const absolutePath = join(root, path);
    updateHashField(hash, "path", path);
    let info;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        updateHashField(hash, "type", "missing");
        continue;
      }
      throw error;
    }

    updateHashField(hash, "mode", (info.mode & 0o7777).toString(8));
    if (info.isFile()) {
      updateHashField(hash, "type", "file");
      updateHashField(hash, "content", await readFile(absolutePath));
    } else if (info.isSymbolicLink()) {
      updateHashField(hash, "type", "symlink");
      updateHashField(hash, "content", await readlink(absolutePath));
    } else if (info.isDirectory()) {
      updateHashField(hash, "type", "directory");
    } else {
      updateHashField(hash, "type", "special");
    }
  }

  return hash.digest("hex");
}

async function computeBuildOutputIdentity(root) {
  const [tracked, untracked] = await Promise.all([
    runGit(root, ["ls-files", "--cached", "-z"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  // The native artifact is excluded so source and binary built from the same package outputs agree.
  const outputRoots = [
    ...new Set([...splitNullTerminated(tracked), ...splitNullTerminated(untracked)]),
  ]
    .filter((path) => path.endsWith("/package.json") && path !== "station/package.json")
    .map((path) => join(dirname(path), "dist"))
    .sort(compareUtf8);
  const hash = createHash("sha256");
  updateHashField(hash, "domain", BUILD_OUTPUT_IDENTITY_DOMAIN);
  for (const outputRoot of outputRoots) {
    await updateOutputHash(hash, root, outputRoot);
  }
  return hash.digest("hex");
}

async function updateOutputHash(hash, root, path) {
  if (path === "packages/runtime/dist/station-build-id") return;
  updateHashField(hash, "path", path);
  const absolutePath = join(root, path);
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      updateHashField(hash, "type", "missing");
      return;
    }
    throw error;
  }

  updateHashField(hash, "mode", (info.mode & 0o7777).toString(8));
  if (info.isFile()) {
    updateHashField(hash, "type", "file");
    updateHashField(hash, "content", await readFile(absolutePath));
    return;
  }
  if (info.isSymbolicLink()) {
    updateHashField(hash, "type", "symlink");
    updateHashField(hash, "content", await readlink(absolutePath));
    return;
  }
  if (!info.isDirectory()) {
    updateHashField(hash, "type", "special");
    return;
  }

  updateHashField(hash, "type", "directory");
  const children = (await readdir(absolutePath)).sort(compareUtf8);
  for (const child of children) {
    await updateOutputHash(hash, root, join(path, child));
  }
}

export async function readBuildIdentity(root = repoRoot) {
  const identity = (await readFile(buildIdentityPath(root), "utf8")).trim();
  if (!BUILD_IDENTITY_PATTERN.test(identity)) {
    throw new Error(`Invalid Station build identity at ${buildIdentityPath(root)}.`);
  }
  return identity;
}

/** Proves current inputs, package outputs, and the published sidecar still match. */
export async function verifyBuildIdentity(identity, root = repoRoot) {
  try {
    const [computedIdentity, publishedIdentity] = await Promise.all([
      computeBuildIdentity(root),
      readBuildIdentity(root),
    ]);
    return computedIdentity === identity && publishedIdentity === identity;
  } catch {
    return false;
  }
}

/** Atomically publishes one validated identity through a private fsynced temporary file. */
export async function publishBuildIdentity(identity, root = repoRoot) {
  if (!BUILD_IDENTITY_PATTERN.test(identity)) {
    throw new Error("Station build identity must be 64 lowercase hexadecimal characters.");
  }
  const path = buildIdentityPath(root);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  let file;
  try {
    file = await open(temporaryPath, "wx", 0o644);
    await file.chmod(0o644);
    await file.writeFile(`${identity}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Removes stale identity, runs a build, and publishes only if its inputs stayed fixed. */
export async function buildWithIdentity(root, runBuildTask) {
  const inputIdentity = await computeBuildInputIdentity(root);
  const path = buildIdentityPath(root);
  await rm(path, { force: true });
  try {
    await runBuildTask();
    const completedInputIdentity = await computeBuildInputIdentity(root);
    if (completedInputIdentity !== inputIdentity) {
      throw new Error(
        "Station build inputs changed while the build was running; rebuild from a stable checkout.",
      );
    }
    const identity = await computeBuildIdentityFromInput(inputIdentity, root);
    await publishBuildIdentity(identity, root);
  } catch (error) {
    try {
      await rm(path, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Station build failed and its stale build identity could not be removed.",
      );
    }
    throw error;
  }
}

async function build() {
  await buildWithIdentity(repoRoot, () => run("pnpm", ["exec", "turbo", "run", "build"], repoRoot));
}

async function requireCurrentBuildIdentity(identity) {
  if (!(await verifyBuildIdentity(identity, repoRoot))) {
    throw new Error(
      "Station build identity does not match the current checkout and production outputs; run pnpm build.",
    );
  }
}

async function run(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} exited from signal ${signal}.`));
        return;
      }
      resolveExit(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${exitCode}.`);
  }
}

async function runGit(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "buffer",
    env: environmentWithoutGitLocals(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function environmentWithoutGitLocals() {
  const env = { ...process.env };
  for (const key of gitLocalEnvironmentVariables) delete env[key];
  return env;
}

function splitNullTerminated(value) {
  return value
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function updateHashField(hash, label, value) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(label);
  hash.update("\0");
  hash.update(String(content.byteLength));
  hash.update("\0");
  hash.update(content);
  hash.update("\0");
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      await build();
    } else if (args.length === 2 && args[0] === "--verify" && args[1] !== undefined) {
      await requireCurrentBuildIdentity(args[1]);
    } else {
      throw new Error("Usage: build-identity.mjs [--verify <identity>]");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
