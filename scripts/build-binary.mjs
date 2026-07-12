#!/usr/bin/env bun
import { cp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_BUN_VERSION = "1.3.14";
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const stationRoot = join(repoRoot, "station");
const excludedOpenTuiParserAssets = new Set([
  "javascript/highlights.scm",
  "javascript/tree-sitter-javascript.wasm",
  "typescript/highlights.scm",
  "typescript/tree-sitter-typescript.wasm",
  "markdown/highlights.scm",
  "markdown/injections.scm",
  "markdown/tree-sitter-markdown.wasm",
  "markdown_inline/highlights.scm",
  "markdown_inline/tree-sitter-markdown_inline.wasm",
  "zig/highlights.scm",
  "zig/tree-sitter-zig.wasm",
]);

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

function openTuiNativeAsset() {
  const asset = {
    "darwin:arm64": "@opentui/core-darwin-arm64/libopentui.dylib",
    "darwin:x64": "@opentui/core-darwin-x64/libopentui.dylib",
    "linux:arm64": "@opentui/core-linux-arm64/libopentui.so",
    "linux:x64": "@opentui/core-linux-x64/libopentui.so",
  }[`${process.platform}:${process.arch}`];
  if (asset === undefined)
    fail(`Unsupported OpenTUI build host: ${process.platform}/${process.arch}`);
  return asset;
}

async function run(command, args, cwd) {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    fail(`${command} ${args.join(" ")} exited with code ${exitCode}.`);
  }
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

function openTuiParserAssetPlugin() {
  const observed = new Set();
  return {
    name: "exclude-unused-opentui-parser-assets",
    setup(build) {
      build.onResolve({ filter: /\/assets\/.*\.(?:scm|wasm)$/ }, (args) => {
        if (!args.importer.includes("/node_modules/@opentui/core/")) return;
        const asset = args.path.replace(/^\.\/assets\//, "");
        if (!excludedOpenTuiParserAssets.has(asset)) {
          throw new Error(`Unexpected OpenTUI parser asset: ${asset}`);
        }
        observed.add(asset);
        return { path: asset, namespace: "excluded-opentui-parser-asset" };
      });
      build.onLoad({ filter: /.*/, namespace: "excluded-opentui-parser-asset" }, () => ({
        contents: 'export default "";',
        loader: "js",
      }));
    },
    assertObserved() {
      const missing = [...excludedOpenTuiParserAssets].filter((asset) => !observed.has(asset));
      if (missing.length > 0 || observed.size !== excludedOpenTuiParserAssets.size) {
        fail(`OpenTUI parser asset graph changed; missing: ${missing.join(", ") || "none"}.`);
      }
    },
  };
}

async function main() {
  if (Bun.version !== REQUIRED_BUN_VERSION) {
    fail(`build:binary requires Bun ${REQUIRED_BUN_VERSION}; found ${Bun.version}.`);
  }
  const { version } = parseArgs(process.argv.slice(2));
  const outputDir = join(stationRoot, "dist", "bin");
  const outputPath = join(outputDir, "stn");
  const piBundlePath = join(stationRoot, "dist", "piExtension.mjs");
  const openTuiAssetModulePath = join(stationRoot, "dist", "openTuiAsset.mjs");

  await run("pnpm", ["build"], repoRoot);
  await run("bun", ["run", "link:station"], stationRoot);
  await run("bun", ["run", "build:ctty-helper"], stationRoot);

  await mkdir(dirname(piBundlePath), { recursive: true });
  await writeFile(
    openTuiAssetModulePath,
    `import asset from ${JSON.stringify(`../node_modules/${openTuiNativeAsset()}`)} with { type: "file" };\nexport default asset;\n`,
  );
  await checkedBuild(
    {
      entrypoints: [join(repoRoot, "integrations", "harness", "pi", "src", "piExtension.ts")],
      outdir: dirname(piBundlePath),
      naming: "piExtension.mjs",
      target: "node",
      format: "esm",
      sourcemap: "none",
      minify: true,
      keepNames: true,
    },
    "Pi extension bundle",
  );

  await mkdir(outputDir, { recursive: true });
  await rm(outputPath, { force: true });
  const parserAssetPlugin = openTuiParserAssetPlugin();
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
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
      minify: true,
      keepNames: true,
      plugins: [parserAssetPlugin],
    },
    "Station binary compile",
  );
  parserAssetPlugin.assertObserved();

  await replaceSymlink(join(outputDir, "stn-ingress"), "stn");
  await replaceSymlink(join(outputDir, "stn-tmux-popup"), "stn");
  await cp(join(repoRoot, "LICENSE"), join(outputDir, "LICENSE"));
  const { size } = await stat(outputPath);
  process.stdout.write(`Built ${outputPath} (${nativeTarget()}, ${version}, ${size} bytes).\n`);
}

await main();
