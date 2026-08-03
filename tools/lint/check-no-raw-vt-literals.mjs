#!/usr/bin/env node

// Guardrail: production leaves compose VT from station/src/terminal/protocol
// vocabulary instead of embedding control bytes, mode values, or xterm parser
// identities inline.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = process.cwd();
const ignoredDirs = new Set(["node_modules", "dist", ".turbo", "coverage"]);
const syntaxDefinition = "station/src/terminal/protocol/syntax.ts";
const modeDefinition = "station/src/terminal/protocol/decset.ts";
const protocolRoot = "station/src/terminal/protocol/";
const allModeValues = modeValues(readFileSync(join(root, modeDefinition), "utf8"));
const distinctiveModeValues = new Set([...allModeValues].filter((value) => value >= 1002));
const rawControlEscape = /\\(?:x(?:07|1b)|u(?:0007|001b)|u\{(?:7|1b)\})/iu;

export function inspectVtSource(rel, source) {
  const normalized = rel.split("\\").join("/");
  if (!shouldCheck(normalized)) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    normalized,
    source,
    ts.ScriptTarget.Latest,
    true,
    normalized.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];

  const add = (node, message) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      line: position.line + 1,
      column: position.character + 1,
      message,
    });
  };

  const visit = (node) => {
    if (isStringSourceNode(node)) {
      const raw = node.getText(sourceFile);
      if (rawControlEscape.test(raw) || raw.includes("\x1b") || raw.includes("\x07")) {
        add(node, "raw ESC/BEL literal; use terminal/protocol typed vocabulary");
      }
    }

    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      if (
        normalized !== modeDefinition &&
        (distinctiveModeValues.has(value) ||
          (allModeValues.has(value) && isDirectVtParameter(node, sourceFile)))
      ) {
        add(node, `raw terminal mode ${value}; use AnsiMode or DecMode`);
      }
    }

    if (ts.isCallExpression(node)) {
      const identifier = node.arguments[0];
      if (
        isFunctionParserRegistration(node.expression) &&
        identifier !== undefined &&
        ts.isObjectLiteralExpression(identifier)
      ) {
        add(identifier, "inline parser identifier; use CsiCommand or EscCommand");
      }
      if (
        isOscParserRegistration(node.expression) &&
        identifier !== undefined &&
        ts.isNumericLiteral(identifier)
      ) {
        add(identifier, "inline OSC command; use OscCommand");
      }
    }

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes("protocol/internal/") &&
      !normalized.startsWith(protocolRoot)
    ) {
      add(node.moduleSpecifier, "protocol internal encoder imported outside terminal/protocol");
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function modeValues(source) {
  const sourceFile = ts.createSourceFile(
    modeDefinition,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const values = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === "AnsiMode" || node.name.text === "DecMode") &&
      node.initializer !== undefined &&
      ts.isAsExpression(node.initializer) &&
      ts.isObjectLiteralExpression(node.initializer.expression)
    ) {
      for (const property of node.initializer.expression.properties) {
        if (ts.isPropertyAssignment(property) && ts.isNumericLiteral(property.initializer)) {
          values.add(Number(property.initializer.text));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

function shouldCheck(rel) {
  if (!/\.(?:ts|tsx)$/.test(rel) || /\.d\.ts$/.test(rel)) {
    return false;
  }
  if (
    rel === syntaxDefinition ||
    /\.(?:test|spec)\.(?:ts|tsx)$/.test(rel) ||
    rel.includes("/terminal/vt/cases/")
  ) {
    return false;
  }
  return true;
}

function isStringSourceNode(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

function isFunctionParserRegistration(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    (expression.name.text === "registerCsiHandler" || expression.name.text === "registerEscHandler")
  );
}

function isOscParserRegistration(expression) {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "registerOscHandler";
}

function isDirectVtParameter(node, sourceFile) {
  return ts.isTemplateSpan(node.parent) && isVtConstructionContext(node, sourceFile);
}

function isVtConstructionContext(node, sourceFile) {
  let current = node.parent;
  while (current !== undefined && !ts.isStatement(current)) {
    if (ts.isTemplateExpression(current) || ts.isBinaryExpression(current)) {
      const text = current.getText(sourceFile);
      if (text.includes("VtPrefix.Csi") || text.includes("C0.Escape")) {
        return true;
      }
    }
    if (ts.isCallExpression(current)) {
      const callee = current.expression.getText(sourceFile);
      if (callee === "setDecPrivateMode" || callee === "resetDecPrivateMode") {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
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

function run() {
  const targets = process.argv.slice(2);
  const roots = targets.length === 0 ? ["station/src"] : targets;
  let count = 0;
  for (const target of roots) {
    const absoluteTarget = join(root, target);
    const files = statSync(absoluteTarget).isDirectory() ? walk(absoluteTarget) : [absoluteTarget];
    for (const file of files) {
      const rel = relative(root, file).split("\\").join("/");
      const source = readFileSync(file, "utf8");
      for (const violation of inspectVtSource(rel, source)) {
        count += 1;
        process.stderr.write(`${rel}:${violation.line}:${violation.column} ${violation.message}\n`);
      }
    }
  }
  if (count > 0) {
    process.stderr.write(`\nno-raw-vt-literals: ${count} violation(s).\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
