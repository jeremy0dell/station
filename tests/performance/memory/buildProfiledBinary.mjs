#!/usr/bin/env bun
import { chmod, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStationBinaryBuildOptions } from "../../../scripts/build-binary.mjs";
import { readBuildIdentity, verifyBuildIdentity } from "../../../scripts/build-identity.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageVersion = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).version;
const diagnosticEntrypoint = join(repoRoot, "tests", "performance", "memory", "profiledStnMain.ts");

/** Compiles one production-contract or sampler-wrapped Station binary under the selected Bun. */
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.expectedBunVersion !== undefined && Bun.version !== options.expectedBunVersion) {
    throw new Error(
      `Profile binary requires Bun ${options.expectedBunVersion}; selected runtime is ${Bun.version}.`,
    );
  }
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("package.json version must be a non-empty string.");
  }
  await ensureEmbeddedAssets();
  const buildIdentity = await readBuildIdentity(repoRoot);
  const pluginBody = await readFile(
    join(repoRoot, "integrations", "harness", "opencode", "pluginScriptBody.js"),
    "utf8",
  );
  await mkdir(resolve(options.output, ".."), { recursive: true });
  const build = await Bun.build(
    createStationBinaryBuildOptions({
      outputPath: options.output,
      version: packageVersion,
      buildIdentity,
      openCodePluginBody: pluginBody,
      entrypoint: options.mode === "diagnostic" ? diagnosticEntrypoint : undefined,
    }),
  );
  if (!build.success) {
    throw new Error(build.logs.map((log) => String(log)).join("\n"));
  }
  await chmod(options.output, 0o755);
  if (!(await verifyBuildIdentity(buildIdentity, repoRoot))) {
    throw new Error("Station inputs changed while compiling the profile binary.");
  }
  process.stdout.write(
    `${JSON.stringify({
      output: options.output,
      mode: options.mode,
      bunVersion: Bun.version,
      stationVersion: packageVersion,
      buildIdentity,
    })}\n`,
  );
}

/** Materializes the same PTY/Pi assets required by the ordinary compiled entrypoint. */
async function ensureEmbeddedAssets() {
  const stationDist = join(repoRoot, "station", "dist");
  await mkdir(stationDist, { recursive: true });
  const child = Bun.spawn(
    [process.execPath, "run", "--cwd", join(repoRoot, "station"), "build:ctty-helper"],
    {
      cwd: repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await child.exited) !== 0) throw new Error("Could not build the compiled PTY helper.");
  const result = await Bun.build({
    entrypoints: [join(repoRoot, "integrations", "harness", "pi", "src", "piExtension.ts")],
    outdir: stationDist,
    naming: "piExtension.mjs",
    target: "node",
    format: "esm",
    sourcemap: "none",
  });
  if (!result.success) throw new Error(result.logs.map((log) => String(log)).join("\n"));
}

function parseArgs(argv) {
  let output;
  let mode = "production";
  let expectedBunVersion;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      output = argv[++index];
    } else if (arg === "--mode") {
      mode = argv[++index];
    } else if (arg === "--expected-bun-version") {
      expectedBunVersion = argv[++index];
    } else {
      throw new Error(`Unsupported profile binary argument: ${arg}`);
    }
  }
  if (output === undefined || !isAbsolute(output)) {
    throw new Error("Profile binary requires an absolute --output path.");
  }
  if (mode !== "production" && mode !== "diagnostic") {
    throw new Error(`Unsupported profile binary mode: ${mode}`);
  }
  return { output, mode, expectedBunVersion };
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
