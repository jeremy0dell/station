#!/usr/bin/env bun
import { cp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildIdentity, verifyBuildIdentity } from "./build-identity.mjs";
import {
  assertBunVersion,
  environmentWithBunRuntime,
  locateBunRuntime,
  requiredBunVersion,
} from "./bun-version.mjs";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const stationRoot = join(repoRoot, "station");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let version;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      version = argv[index + 1];
      index += 1;
      continue;
    }
    fail(`Unsupported build:binary argument: ${arg}`);
  }
  if (version === undefined || !SEMVER.test(version)) {
    fail("build:binary requires --version <semver>.");
  }
  return { version };
}

function nativeTarget() {
  // OpenTUI and the controlling-terminal helper make every artifact native-only.
  const target = {
    "darwin:arm64": "bun-darwin-arm64",
    "darwin:x64": "bun-darwin-x64-baseline",
    "linux:arm64": "bun-linux-arm64",
    "linux:x64": "bun-linux-x64-baseline",
  }[`${process.platform}:${process.arch}`];
  if (target === undefined) {
    fail(`Unsupported binary build host: ${process.platform}/${process.arch}`);
  }
  return target;
}

async function run(command, args, cwd, env = process.env) {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    fail(`${command} ${args.join(" ")} exited with code ${exitCode}.`);
  }
}

/** Runs a Bun child through the already-validated runtime and keeps nested Bun dispatch on it. */
export async function runWithBunExecutable(
  bunRuntime,
  args,
  cwd,
  runner = run,
  environment = process.env,
) {
  return runner(
    bunRuntime.executable,
    args,
    cwd,
    environmentWithBunRuntime(bunRuntime, environment),
  );
}

/** Preserves the existing binary until the source build and identity have been admitted. */
export async function removeBinaryOutputAfterSourceAdmission(outputPath, admitSourceBuild) {
  const admission = await admitSourceBuild();
  await rm(outputPath, { force: true });
  return admission;
}

async function checkedBuild(options, label) {
  const result = await Bun.build(options);
  if (result.success) return;
  for (const log of result.logs) {
    process.stderr.write(`${log}\n`);
  }
  fail(`${label} failed.`);
}

async function replaceSymlink(path, target) {
  await rm(path, { force: true });
  await symlink(target, path);
}

async function main() {
  const expectedBunVersion = await requiredBunVersion(repoRoot);
  try {
    assertBunVersion(Bun.version, expectedBunVersion);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const { version } = parseArgs(process.argv.slice(2));
  const outputDir = join(stationRoot, "dist", "bin");
  const outputPath = join(outputDir, "stn");
  const piBundlePath = join(stationRoot, "dist", "piExtension.mjs");
  let bunRuntime;
  try {
    bunRuntime = await locateBunRuntime(process.execPath, { cwd: repoRoot });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const buildIdentity = await removeBinaryOutputAfterSourceAdmission(outputPath, async () => {
    await runWithBunExecutable(bunRuntime, ["run", "build"], repoRoot);
    let identity;
    try {
      identity = await readBuildIdentity(repoRoot);
    } catch {
      fail("Station source build did not publish a valid build identity.");
    }
    if (identity === undefined || !(await verifyBuildIdentity(identity, repoRoot))) {
      fail("Station build inputs changed after the source build; rebuild from a stable checkout.");
    }
    return identity;
  });
  await runWithBunExecutable(bunRuntime, ["run", "build:ctty-helper"], stationRoot);

  await mkdir(dirname(piBundlePath), { recursive: true });
  await checkedBuild(
    {
      entrypoints: [join(repoRoot, "integrations", "harness", "pi", "src", "piExtension.ts")],
      outdir: dirname(piBundlePath),
      naming: "piExtension.mjs",
      target: "node",
      format: "esm",
      sourcemap: "none",
    },
    "Pi extension bundle",
  );

  const openCodePluginBody = await readFile(
    join(repoRoot, "integrations", "harness", "opencode", "pluginScriptBody.js"),
    "utf8",
  );

  await mkdir(outputDir, { recursive: true });
  await checkedBuild(
    {
      entrypoints: [join(stationRoot, "src", "bin", "stnMain.ts")],
      compile: {
        target: nativeTarget(),
        outfile: outputPath,
        // A compiled artifact must not execute ambient project startup configuration.
        autoloadDotenv: false,
        autoloadBunfig: false,
      },
      define: {
        STATION_BUILD_VERSION: JSON.stringify(version),
        STATION_BUILD_COMPILED: "true",
        STATION_BUILD_IDENTITY: JSON.stringify(buildIdentity),
        STATION_BUILD_OPENCODE_PLUGIN_BODY: JSON.stringify(openCodePluginBody),
      },
    },
    "Station binary compile",
  );
  if (!(await verifyBuildIdentity(buildIdentity, repoRoot))) {
    await rm(outputPath, { force: true });
    fail(
      "Station build inputs or published identity changed during binary compilation; rebuild from a stable checkout.",
    );
  }

  await replaceSymlink(join(outputDir, "stn-ingress"), "stn");
  await replaceSymlink(join(outputDir, "stn-tmux-popup"), "stn");
  await cp(join(repoRoot, "LICENSE"), join(outputDir, "LICENSE"));
  process.stdout.write(`Built ${outputPath} (${nativeTarget()}, ${version}).\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
