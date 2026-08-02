#!/usr/bin/env node

// Guardrail: Station production code resolves color through the canonical theme,
// never raw #rrggbb in renderer or terminal leaves. biome ignores station/, so
// this cannot be a biome rule. Tests and VT protocol cases may retain fixed
// values when the assertion must remain independent from Station's palette.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirs = new Set(["node_modules", "dist", ".turbo", "coverage"]);
const allowedFiles = new Set([
  "station/src/theme/builtInTheme.ts",
  // Contract/protocol expectations intentionally stay independent from theme ownership.
  "station/src/theme/builtInTheme.test.ts",
  "station/src/theme/openTuiColor.test.ts",
  "station/src/terminal/TerminalPane.test.tsx",
  "station/src/terminal/ptyPipeline.smoke.test.ts",
  "station/src/terminal/vt/palette.test.ts",
  "station/src/terminal/vt/screen.test.ts",
]);
const hexPattern = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/;

const targets = process.argv.slice(2);
const roots = targets.length === 0 ? ["station/src"] : targets;

let violations = 0;
for (const target of roots) {
  const absoluteTarget = join(root, target);
  const files = statSync(absoluteTarget).isDirectory() ? walk(absoluteTarget) : [absoluteTarget];
  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/");
    if (shouldCheck(rel)) {
      violations += checkFile(file, rel);
    }
  }
}

if (violations > 0) {
  process.stderr.write(
    `\nno-raw-hex: ${violations} raw colour literal(s) outside station/src/theme/builtInTheme.ts.\n` +
      "Move production values into the canonical built-in theme and consume a semantic role.\n",
  );
  process.exitCode = 1;
}

function shouldCheck(rel) {
  if (!/\.(ts|tsx)$/.test(rel) || /\.d\.ts$/.test(rel)) {
    return false;
  }
  if (allowedFiles.has(rel) || rel.includes("/terminal/vt/cases/")) {
    return false;
  }
  return true;
}

function checkFile(file, rel) {
  const lines = readFileSync(file, "utf8").split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Ignore hex that only appears in a comment (documentation, migration notes).
    const code = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
    if (line.trimStart().startsWith("*")) {
      continue;
    }
    const match = hexPattern.exec(code);
    if (match !== null) {
      count += 1;
      process.stderr.write(`${rel}:${i + 1}:${match.index + 1} raw colour literal ${match[0]}\n`);
    }
  }
  return count;
}

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (ignoredDirs.has(name)) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      entries.push(...walk(path));
    } else {
      entries.push(path);
    }
  }
  return entries.sort();
}
