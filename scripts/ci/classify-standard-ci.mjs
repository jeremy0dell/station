#!/usr/bin/env node

import { readFileSync } from "node:fs";

const paths = readFileSync(0)
  .toString("utf8")
  .split("\0")
  .filter((path) => path.length > 0);

const conservativeFallback = paths.length === 0;
const docsOnly = !conservativeFallback && paths.every(isDocumentationPath);
const ciInfrastructure = paths.some(isCiInfrastructurePath);
const installer = conservativeFallback || ciInfrastructure || paths.some(isInstallerValidationPath);
const binary = conservativeFallback || ciInfrastructure || paths.some(isBinaryValidationPath);

process.stdout.write(`docs_only=${docsOnly}\n`);
process.stdout.write(`installer=${installer}\n`);
process.stdout.write(`binary=${binary}\n`);

function isDocumentationPath(path) {
  return path.startsWith("docs/") || path.endsWith(".md");
}

function isCiInfrastructurePath(path) {
  return (
    path === ".github/workflows/standard-ci.yml" ||
    path.startsWith(".github/actions/setup-ci/") ||
    path === "scripts/ci/classify-standard-ci.mjs" ||
    path === "tests/diagnostics/ci-classification.test.ts" ||
    path === "tests/diagnostics/ci-workflow-policy.test.ts"
  );
}

function isInstallerValidationPath(path) {
  return (
    path === "package.json" ||
    path === "pnpm-lock.yaml" ||
    path === "LICENSE" ||
    path === "scripts/install.sh" ||
    path.startsWith("scripts/release/") ||
    path === "scripts/test-runners/run-install-smoke.mjs" ||
    path === "scripts/test-runners/run-release-smoke.mjs" ||
    path === ".github/workflows/release.yml" ||
    path === ".github/workflows/promote-release.yml"
  );
}

function isBinaryValidationPath(path) {
  if (isDocumentationPath(path) || isInstallerOnlyPath(path)) return false;
  if (path.startsWith(".github/")) return false;
  if (path.startsWith("config/vitest/")) return false;
  if (path.startsWith("tests/")) return false;
  if (path.startsWith("tools/")) return false;
  if (path === "lefthook.yml" || path === "biome.json") return false;
  if (path.includes("/__tests__/")) return false;
  if (path.includes("/test/") || path.includes("/tests/")) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) return false;
  if (path.startsWith("scripts/test-runners/")) {
    return path === "scripts/test-runners/run-binary-smoke.mjs";
  }
  return true;
}

function isInstallerOnlyPath(path) {
  return (
    path === "scripts/install.sh" ||
    path.startsWith("scripts/release/") ||
    path === "scripts/test-runners/run-install-smoke.mjs" ||
    path === "scripts/test-runners/run-release-smoke.mjs" ||
    path === ".github/workflows/release.yml" ||
    path === ".github/workflows/promote-release.yml"
  );
}
