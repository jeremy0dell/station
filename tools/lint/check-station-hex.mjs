#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const roots = ["station/src", "packages/dashboard-core/src"];
const rawHexStringPattern = /(["'`])#[0-9a-fA-F]{6}\1/g;

const violations = [];

for (const root of roots) {
  walk(join(repoRoot, root), (filePath) => {
    const relPath = relativePath(filePath);
    if (!/\.(ts|tsx)$/.test(relPath) || allowsRawHex(relPath)) {
      return;
    }
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(rawHexStringPattern)) {
      const index = match.index ?? 0;
      const { line, column } = locationForIndex(source, index);
      violations.push(`${relPath}:${line}:${column} ${match[0]}`);
    }
  });
}

if (violations.length > 0) {
  console.error("Raw Station chrome hex literals must live in station/src/station/view/theme.ts.");
  console.error(violations.join("\n"));
  process.exit(1);
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, visit);
    } else if (entry.isFile()) {
      visit(path);
    }
  }
}

function allowsRawHex(relPath) {
  return (
    relPath === "station/src/station/view/theme.ts" ||
    relPath.startsWith("station/src/terminal/vt/") ||
    relPath.includes("/__snapshots__/") ||
    relPath.includes("/fixtures/") ||
    /\.(test|spec)\.(ts|tsx)$/.test(relPath)
  );
}

function locationForIndex(source, index) {
  const prefix = source.slice(0, index);
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function relativePath(filePath) {
  return relative(repoRoot, filePath).replaceAll("\\", "/");
}
