#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function fail(message) {
  throw new Error(`Release installer render failed: ${message}`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--")) fail(`unknown argument '${name ?? ""}'.`);
    if (value === undefined || value.startsWith("--")) fail(`${name} requires a value.`);
    if (name in options) fail(`${name} may be specified only once.`);
    options[name] = value;
    index += 1;
  }

  const allowed = new Set(["--output", "--source", "--version"]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) fail(`unknown option '${name}'.`);
  }
  for (const name of allowed) {
    if (options[name] === undefined) fail(`${name} is required.`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = options["--version"];
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      version,
    )
  ) {
    fail(`version must be SemVer without build metadata: '${version}'.`);
  }

  const sourcePath = resolve(options["--source"]);
  const outputPath = resolve(options["--output"]);
  const source = await readFile(sourcePath, "utf8");
  const marker = 'embedded_version=""';
  const occurrences = source.split(marker).length - 1;
  if (occurrences !== 1) {
    fail(`expected exactly one embedded-version marker; found ${occurrences}.`);
  }
  const rendered = source.replace(marker, `embedded_version="v${version}"`);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered, { mode: 0o755 });
  await chmod(outputPath, 0o755);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
