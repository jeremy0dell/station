#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative, sep } from "node:path";

const require = createRequire(`${process.cwd()}/package.json`);
const ts = require("typescript");

const root = process.cwd();
const defaultTargets = [
  "integrations/harness/claude/src",
  "integrations/harness/cursor/src",
  "integrations/terminal/tmux/src/popup.ts",
  "integrations/terminal/tmux/src/popup",
];
const ignoredDirs = new Set(["node_modules", "dist", ".turbo", "coverage"]);
const maxDiagnostics = Number.parseInt(process.env.STATION_SOURCE_ORDER_MAX ?? "200", 10);
const phaseNames = [
  "imports",
  "public type contracts and re-exports",
  "private types",
  "schemas and constants",
  "private helpers",
  "exported runtime functions",
];

let totalFailures = 0;
let printedFailures = 0;
const failuresByFile = new Map();
const targets = process.argv.slice(2);
const roots = targets.length === 0 ? defaultTargets : targets;

for (const target of roots) {
  const absoluteTarget = join(root, target);
  const targetStat = statSync(absoluteTarget);
  const files = targetStat.isDirectory() ? walk(absoluteTarget) : [absoluteTarget];
  for (const file of files) {
    const rel = relative(root, file);
    if (shouldCheck(rel)) {
      checkFile(file, rel);
    }
  }
}

for (const [file, count] of [...failuresByFile.entries()].sort(
  (left, right) => right[1] - left[1],
)) {
  console.error(`${file}: ${count} violation(s)`);
}

if (totalFailures > printedFailures) {
  console.error(
    `... ${totalFailures - printedFailures} additional violation(s) hidden; set STATION_SOURCE_ORDER_MAX to raise the cap.`,
  );
}

if (totalFailures > 0) {
  console.error(`source-order check: ${totalFailures} violation(s)`);
  process.exitCode = 1;
}

function shouldCheck(rel) {
  if (!/\.(ts|tsx)$/.test(rel) || /\.d\.ts$/.test(rel)) {
    return false;
  }
  const parts = rel.split(sep);
  const name = basename(rel);
  if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) {
    return false;
  }
  return !parts.includes("test") && !parts.includes("__tests__") && !parts.includes("fixtures");
}

function checkFile(file, rel) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  let maxPhase = 0;
  let maxPhaseStatement;

  for (const statement of source.statements) {
    const phase = classify(statement, source);
    if (phase === undefined) {
      continue;
    }

    if (phase < maxPhase) {
      totalFailures += 1;
      failuresByFile.set(rel, (failuresByFile.get(rel) ?? 0) + 1);

      if (printedFailures < maxDiagnostics) {
        reportFailure(source, rel, statement, phase, maxPhase, maxPhaseStatement);
        printedFailures += 1;
      }
      continue;
    }

    if (phase > maxPhase) {
      maxPhase = phase;
      maxPhaseStatement = statement;
    }
  }
}

function classify(statement, source) {
  if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
    return 0;
  }

  if (ts.isExportDeclaration(statement)) {
    return 1;
  }

  if (isPublicTypeContract(statement)) {
    return isSchemaDerivedType(statement, source) ? 3 : 1;
  }

  if (isPrivateType(statement)) {
    return 2;
  }

  if (isSchemaOrConstant(statement)) {
    return 3;
  }

  if (isPrivateHelper(statement)) {
    return 4;
  }

  if (isExportedRuntime(statement)) {
    return 5;
  }

  return undefined;
}

function isPublicTypeContract(statement) {
  return (
    hasExportModifier(statement) &&
    (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement))
  );
}

function isSchemaDerivedType(statement, source) {
  return (
    ts.isTypeAliasDeclaration(statement) &&
    containsTypeNode(statement.type, source, (node) => {
      if (ts.isTypeReferenceNode(node)) {
        const name = entityNameText(node.typeName);
        return name === "z.infer" || name.endsWith(".infer");
      }
      if (ts.isTypeQueryNode(node)) {
        return entityNameText(node.exprName).endsWith("Schema");
      }
      return false;
    })
  );
}

function isPrivateType(statement) {
  return (
    !hasExportModifier(statement) &&
    (ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isEnumDeclaration(statement))
  );
}

function isSchemaOrConstant(statement) {
  if (ts.isEnumDeclaration(statement)) {
    return hasExportModifier(statement);
  }
  return ts.isVariableStatement(statement) && !variableStatementHasFunctionInitializer(statement);
}

function isPrivateHelper(statement) {
  if (hasExportModifier(statement)) {
    return false;
  }
  return (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    (ts.isVariableStatement(statement) && variableStatementHasFunctionInitializer(statement))
  );
}

function isExportedRuntime(statement) {
  if (!hasExportModifier(statement)) {
    return false;
  }
  return (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    (ts.isVariableStatement(statement) && variableStatementHasFunctionInitializer(statement))
  );
}

function variableStatementHasFunctionInitializer(statement) {
  return statement.declarationList.declarations.some((declaration) => {
    const initializer = declaration.initializer;
    return (
      initializer !== undefined &&
      (ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer) ||
        ts.isClassExpression(initializer))
    );
  });
}

function hasExportModifier(statement) {
  return (
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

function containsTypeNode(node, source, predicate) {
  if (predicate(node)) {
    return true;
  }
  return node.getChildren(source).some((child) => containsTypeNode(child, source, predicate));
}

function entityNameText(name) {
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  return `${entityNameText(name.left)}.${name.right.text}`;
}

function reportFailure(source, rel, statement, phase, maxPhase, maxPhaseStatement) {
  const pos = source.getLineAndCharacterOfPosition(statement.getStart(source));
  const previousPos =
    maxPhaseStatement === undefined
      ? undefined
      : source.getLineAndCharacterOfPosition(maxPhaseStatement.getStart(source));
  const previousLocation =
    previousPos === undefined ? "" : `; later phase first seen at ${previousPos.line + 1}`;
  console.error(
    `${rel}:${pos.line + 1}:${pos.character + 1} ${phaseNames[phase]} appears after ${phaseNames[maxPhase]}${previousLocation}`,
  );
}

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (ignoredDirs.has(name)) {
      continue;
    }
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      entries.push(...walk(path));
    } else {
      entries.push(path);
    }
  }
  return entries.sort();
}
