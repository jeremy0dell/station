#!/usr/bin/env node

// Guardrail: station chrome resolves colour through the token hub
// (station/src/station/view/theme.ts), never raw #rrggbb in the render layer.
// biome ignores station/, so this can't be a biome rule.
//
// Allowed to hold raw hex (documented owners):
//   - station/src/station/view/theme.ts  — the palette + resolver home
//   - station/src/terminal/**            — the VT/xterm + pane palette owner
//   - station/src/welcome/**             — reworked into the M3 Welcome in PR4
// biome intentionally ignores station/, so this cannot be a biome rule.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirs = new Set(["node_modules", "dist", ".turbo", "coverage"]);
const allowedFiles = new Set(["station/src/station/view/theme.ts"]);
const allowedDirs = ["station/src/terminal/", "station/src/welcome/"];
const hexPattern = /#[0-9a-fA-F]{6}\b/;

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
  console.error(
    `\nno-raw-hex: ${violations} raw colour literal(s) outside station/src/station/view/theme.ts.\n` +
      "Move the value into STATION_COLORS (or a named token in theme.ts) and reference it by name.",
  );
  process.exitCode = 1;
}

function shouldCheck(rel) {
  if (!/\.(ts|tsx)$/.test(rel) || /\.d\.ts$/.test(rel)) {
    return false;
  }
  if (allowedFiles.has(rel)) {
    return false;
  }
  return !allowedDirs.some((dir) => rel.startsWith(dir));
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
      console.error(`${rel}:${i + 1}:${match.index + 1} raw colour literal ${match[0]}`);
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
