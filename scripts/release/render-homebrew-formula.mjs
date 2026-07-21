#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function fail(message) {
  throw new Error(`Homebrew formula render failed: ${message}`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith("--")) fail(`unknown argument '${name ?? ""}'.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${name} requires a value.`);
    if (name in options) fail(`${name} may be specified only once.`);
    options[name] = value;
    index += 1;
  }

  const allowed = new Set(["--output", "--revision", "--tag", "--template"]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) fail(`unknown option '${name}'.`);
  }
  for (const name of allowed) {
    if (options[name] === undefined) fail(`${name} is required.`);
  }
  return options;
}

function replaceExactlyOnce(source, pattern, replacement, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    fail(`expected exactly one ${label} field in the formula template; found ${matches.length}.`);
  }
  return source.replace(pattern, replacement);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tag = options["--tag"];
  const revision = options["--revision"];
  if (
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      tag,
    )
  ) {
    fail(`tag must be v-prefixed SemVer without build metadata: '${tag}'.`);
  }
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    fail(`revision must be a full lowercase 40-character Git commit: '${revision}'.`);
  }

  const templatePath = resolve(options["--template"]);
  const outputPath = resolve(options["--output"]);
  let formula = await readFile(templatePath, "utf8");
  formula = replaceExactlyOnce(
    formula,
    /^(\s*)tag:\s+"[^"]+",$/gmu,
    `$1tag:      "${tag}",`,
    "tag",
  );
  formula = replaceExactlyOnce(
    formula,
    /^(\s*)revision:\s+"[0-9a-f]+"$/gmu,
    `$1revision: "${revision}"`,
    "revision",
  );

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, formula, { mode: 0o644 });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
