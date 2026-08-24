#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredBunVersion } from "./bun-version.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(scriptPath), "..");
const preparedRootEnvironmentVariable = "STATION_DEV_TOOLCHAIN_PREPARED_ROOT";

/** Parses the repository-owned Node range and version-selector mirror used before dependencies exist. */
export function parseNodePolicy(engine, selector) {
  const range = /^>=(\d+)\.(\d+) <(\d+)$/u.exec(engine);
  if (range === null) {
    throw new Error(`Unsupported root Node engine policy: ${engine}`);
  }
  const minimumMajor = Number(range[1]);
  const minimumMinor = Number(range[2]);
  const upperMajor = Number(range[3]);
  if (upperMajor !== minimumMajor + 1 || selector !== String(minimumMajor)) {
    throw new Error(`Root Node engine ${engine} and .node-version ${selector} do not agree.`);
  }
  return { engine, minimumMajor, minimumMinor, packageSpec: `node@${selector}` };
}

/** Checks the narrow Node policy without relying on workspace dependencies that may not be installed yet. */
export function nodeVersionSatisfiesPolicy(version, policy) {
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  if (parsed === null) return false;
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  return major === policy.minimumMajor && minor >= policy.minimumMinor;
}

/** Returns whether a devbox invocation needs the root workspace installed before it runs. */
export function devboxRequiresInstall(arguments_) {
  const [target, rawCommand = "start", nestedCommand = "dev"] = arguments_;
  if (target !== "scripts/station-devbox.mjs") return true;
  const command = rawCommand === "--hot" ? "dev" : rawCommand;
  if (command === "tmux") {
    return nestedCommand === "dev" || nestedCommand === "start";
  }
  return command === "dev" || command === "start" || command === "restart";
}

async function main(arguments_) {
  if (arguments_.length === 0) {
    throw new Error("Usage: run-dev-toolchain.mjs <repo-relative-node-script> [args...]");
  }
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const nodeSelector = (await readFile(join(repoRoot, ".node-version"), "utf8")).trim();
  const nodePolicy = parseNodePolicy(packageJson.engines?.node, nodeSelector);
  const expectedBun = await requiredBunVersion(repoRoot);

  if (process.versions.bun !== undefined) {
    if (process.versions.bun !== expectedBun) {
      process.stdout.write(
        `Activating repository Bun ${expectedBun} (current PATH has ${process.versions.bun})…\n`,
      );
      run(process.execPath, ["x", `bun@${expectedBun}`, scriptPath, ...arguments_]);
      return;
    }

    const nodeProbe = spawnSync("node", ["--version"], { encoding: "utf8" });
    const nodeVersion = nodeProbe.status === 0 ? nodeProbe.stdout.trim() : "";
    if (nodeVersionSatisfiesPolicy(nodeVersion, nodePolicy)) {
      run("node", [scriptPath, ...arguments_]);
      return;
    }

    process.stdout.write(
      `Activating repository Node ${nodeSelector} (${nodePolicy.engine}; current PATH has ${nodeVersion || "no Node"})…\n`,
    );
    run(process.execPath, ["x", "-p", nodePolicy.packageSpec, "node", scriptPath, ...arguments_]);
    return;
  }

  if (!nodeVersionSatisfiesPolicy(process.version, nodePolicy)) {
    throw new Error(
      `Repository Node bootstrap failed: found ${process.version}, expected ${nodePolicy.engine}.`,
    );
  }
  const bunProbe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  const bunVersion = bunProbe.status === 0 ? bunProbe.stdout.trim() : "";
  if (bunVersion !== expectedBun) {
    throw new Error(
      `Repository Bun bootstrap failed: found ${bunVersion || "no Bun"}, expected ${expectedBun}.`,
    );
  }

  const installRequired = devboxRequiresInstall(arguments_);
  if (installRequired) {
    process.stdout.write(`Installing the root workspace with Bun ${expectedBun}…\n`);
    run("bun", ["install", "--frozen-lockfile"], { cwd: repoRoot });
  }

  const [target, ...targetArguments] = arguments_;
  const absoluteTarget = resolve(repoRoot, target);
  const targetRelativeToRoot = relative(repoRoot, absoluteTarget);
  if (
    targetRelativeToRoot.length === 0 ||
    targetRelativeToRoot.startsWith("..") ||
    isAbsolute(targetRelativeToRoot)
  ) {
    throw new Error(`Development toolchain target must be inside the repository: ${target}`);
  }
  const env = installRequired
    ? { ...process.env, [preparedRootEnvironmentVariable]: repoRoot }
    : process.env;
  run(process.execPath, [absoluteTarget, ...targetArguments], { cwd: repoRoot, env });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0) process.exit(status);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === scriptPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
