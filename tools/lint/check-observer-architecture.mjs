#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ts = createRequire(import.meta.url)("typescript");

const roles = ["DRIVING PORT", "DRIVEN PORT", "ADAPTER", "USE CASE", "POLICY", "COMPOSITION ROOT"];
const roleSet = new Set(roles);
const allowedRoleTargets = new Map([
  ["DRIVING PORT", new Set(["DRIVING PORT"])],
  ["DRIVEN PORT", new Set(["DRIVEN PORT"])],
  ["POLICY", new Set(["POLICY"])],
  ["USE CASE", new Set(["USE CASE", "POLICY", "DRIVEN PORT"])],
  ["ADAPTER", new Set(["ADAPTER", "DRIVING PORT", "DRIVEN PORT", "POLICY"])],
  ["COMPOSITION ROOT", new Set(roles)],
]);
const defaultSourceRoot = "apps/observer/src";
const defaultCompilerConfig = "apps/observer/tsconfig.json";
const defaultManifestPath = "docs/generated/observer-architecture-manifest.json";
const scanRoots = ["apps", "packages", "integrations"];
const ignoredDirectoryNames = new Set(["node_modules", "dist", ".turbo", "coverage", ".git"]);
const testPathParts = new Set(["test", "tests", "__tests__", "fixture", "fixtures"]);

export function analyzeObserverArchitecture(options = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const sourceRoot = options.sourceRoot ?? defaultSourceRoot;
  const compilerConfig = options.compilerConfig ?? defaultCompilerConfig;
  const manifestPath = options.manifestPath ?? defaultManifestPath;
  const diagnostics = [];
  const sourceRootAbsolute = resolve(rootDir, sourceRoot);
  const compilerConfigAbsolute = resolve(rootDir, compilerConfig);
  const baseConfigAbsolute = resolve(rootDir, options.baseCompilerConfig ?? "tsconfig.base.json");

  const observerConfig = readCompilerConfig(compilerConfigAbsolute, rootDir, diagnostics);
  const baseConfig = readCompilerConfig(baseConfigAbsolute, rootDir, diagnostics);
  const discoveredObserverFiles = walkTypeScriptFiles(sourceRootAbsolute).filter((file) =>
    isProductionSourcePath(file, rootDir),
  );
  const configuredObserverFiles = observerConfig.fileNames.filter((file) =>
    isProductionSourcePath(file, rootDir),
  );
  reportInventoryDifferences({
    configuredFiles: configuredObserverFiles,
    discoveredFiles: discoveredObserverFiles,
    rootDir,
    compilerConfig,
    diagnostics,
  });

  const allTypeScriptFiles = scanRoots.flatMap((scanRoot) =>
    walkTypeScriptFiles(resolve(rootDir, scanRoot)),
  );
  const productionFiles = allTypeScriptFiles.filter((file) =>
    isProductionSourcePath(file, rootDir),
  );
  const program = ts.createProgram({
    rootNames: productionFiles,
    options: {
      ...baseConfig.options,
      noEmit: true,
      allowJs: false,
      checkJs: false,
    },
  });
  const checker = program.getTypeChecker();
  const sourceFiles = new Map();
  for (const file of productionFiles) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile !== undefined) sourceFiles.set(normalizeAbsolute(file), sourceFile);
  }

  const declarationState = collectDeclarationsAndMarkers({
    allTypeScriptFiles,
    sourceFiles,
    checker,
    rootDir,
    diagnostics,
  });
  const packageExports = collectWorkspacePackageExports(rootDir);
  // Module edges retain their direct barrel targets for cycles while declaration aliases resolve to their source owners.
  const moduleAnalyses = [];
  for (const file of discoveredObserverFiles) {
    const sourceFile = sourceFiles.get(normalizeAbsolute(file));
    if (sourceFile === undefined) {
      diagnostics.push(
        createDiagnostic({
          code: "OBS_ARCH_INVENTORY",
          path: relativePosix(rootDir, file),
          ruleId: "COMPLETE_SOURCE_INVENTORY",
          message:
            "The Observer production file was discovered but is absent from the compiler program.",
          correctiveAction: `include it through ${compilerConfig}`,
        }),
      );
      continue;
    }
    moduleAnalyses.push(
      analyzeModuleImports({
        sourceFile,
        rootDir,
        compilerOptions: baseConfig.options,
        packageExports,
        diagnostics,
      }),
    );
  }

  const publicGroups = collectPublicDeclarationGroups({
    sourceFiles,
    checker,
    declarationState,
    rootDir,
    sourceRoot,
  });
  const dependencyState = deriveDeclarationDependencies({
    checker,
    declarationState,
    sourceRoot,
  });
  evaluateRoleDirections({
    dependencyState,
    declarationState,
    sourceRoot,
    diagnostics,
  });
  evaluatePathRules({ moduleAnalyses, rootDir, sourceRoot, diagnostics });
  evaluateCycles({ moduleAnalyses, rootDir, diagnostics });

  const modules = moduleAnalyses
    .map((analysis) => ({
      path: analysis.path,
      exports: publicGroups.get(analysis.path)?.exports ?? [],
      imports: analysis.edges.map(publicImportEdge).sort(compareImportEdges),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const controlledDeclarations = declarationState.controlled
    .map((record) => ({
      path: record.path,
      declaration: record.name,
      kind: record.kind,
      role: record.role,
      purpose: record.purpose,
      dependencies: (dependencyState.get(record.group.key) ?? [])
        .filter((dependency) => dependency.target.marker !== undefined)
        .map((dependency) => ({
          path: dependency.target.path,
          declaration: dependency.target.name,
          kind: dependency.target.kind,
          role: dependency.target.marker.role,
          edgeKind: dependency.edgeKind,
        }))
        .sort(compareDependencies),
    }))
    .sort(compareControlledDeclarations);
  const manifest = {
    schemaVersion: 1,
    sourceRoot,
    compilerConfig,
    modules,
    controlledDeclarations,
  };
  const serializedManifest = serializeManifest(manifest);

  return {
    diagnostics: diagnostics.sort(compareDiagnostics),
    manifest,
    serializedManifest,
    manifestPath,
    rootDir,
  };
}

export function checkObserverArchitecture(options = {}) {
  const result = analyzeObserverArchitecture(options);
  const manifestAbsolute = resolve(result.rootDir, result.manifestPath);
  let currentBytes;
  try {
    currentBytes = readFileSync(manifestAbsolute, "utf8");
  } catch {
    currentBytes = undefined;
  }
  const staleDiagnostic =
    currentBytes === result.serializedManifest
      ? undefined
      : createDiagnostic({
          code: "OBS_ARCH_STALE",
          path: result.manifestPath,
          ruleId: "GENERATED_MANIFEST_CURRENT",
          message: `Generated architecture evidence is missing or stale at ${result.manifestPath}.`,
          correctiveAction: "run pnpm architecture:observer:generate",
        });
  return {
    ...result,
    diagnostics:
      staleDiagnostic === undefined ? result.diagnostics : [...result.diagnostics, staleDiagnostic],
    stale: staleDiagnostic !== undefined,
  };
}

export function writeObserverArchitectureManifest(options = {}) {
  const result = analyzeObserverArchitecture(options);
  if (result.diagnostics.length > 0) return { ...result, wrote: false };
  const target = resolve(result.rootDir, result.manifestPath);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  try {
    writeFileSync(temporary, result.serializedManifest, "utf8");
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { ...result, wrote: true };
}

export function formatArchitectureDiagnostic(diagnostic) {
  const declaration = diagnostic.declaration ?? "<module>";
  const role = diagnostic.role ?? "UNMARKED";
  const location = `${diagnostic.path}:${diagnostic.line}:${diagnostic.column}`;
  const lines = [`${diagnostic.code} ${location} ${declaration} [${role}]`];
  if (diagnostic.edgeKind !== undefined || diagnostic.targetPath !== undefined) {
    const edgeKind = diagnostic.edgeKind ?? "runtime";
    const symbol = diagnostic.symbol ?? "module";
    const targetPath = diagnostic.targetPath ?? "<unresolved>";
    const targetDeclaration = diagnostic.targetDeclaration ?? "<module>";
    const targetRole = diagnostic.targetRole ?? "UNMARKED";
    lines.push(
      `  ${edgeKind} import ${symbol} -> ${targetPath}#${targetDeclaration} [${targetRole}]`,
    );
  }
  lines.push(
    `  violated: ${diagnostic.ruleId} — ${diagnostic.message} Corrective action: ${diagnostic.correctiveAction}.`,
  );
  if (diagnostic.cycle !== undefined) {
    for (const edge of diagnostic.cycle) {
      lines.push(`  ${edge.path} --${edge.edgeKind}:${edge.specifier}--> ${edge.targetPath}`);
    }
  }
  return lines.join("\n");
}

function readCompilerConfig(path, rootDir, diagnostics) {
  if (!existsSync(path)) {
    diagnostics.push(
      createDiagnostic({
        code: "OBS_ARCH_INVENTORY",
        path: relativePosix(rootDir, path),
        ruleId: "COMPLETE_SOURCE_INVENTORY",
        message: "The required TypeScript compiler configuration does not exist.",
        correctiveAction: "restore the checked-in compiler configuration",
      }),
    );
    return { fileNames: [], options: {} };
  }
  const readResult = ts.readConfigFile(path, ts.sys.readFile);
  if (readResult.error !== undefined) {
    reportTypeScriptConfigDiagnostic(readResult.error, rootDir, diagnostics);
    return { fileNames: [], options: {} };
  }
  const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, dirname(path), {}, path);
  for (const error of parsed.errors) reportTypeScriptConfigDiagnostic(error, rootDir, diagnostics);
  return parsed;
}

function reportTypeScriptConfigDiagnostic(error, rootDir, diagnostics) {
  const path =
    error.file?.fileName === undefined
      ? "tsconfig.json"
      : relativePosix(rootDir, error.file.fileName);
  const position =
    error.file === undefined || error.start === undefined
      ? { line: 1, column: 1 }
      : lineAndColumn(error.file, error.start);
  diagnostics.push(
    createDiagnostic({
      code: "OBS_ARCH_INVENTORY",
      path,
      ...position,
      ruleId: "COMPLETE_SOURCE_INVENTORY",
      message: ts.flattenDiagnosticMessageText(error.messageText, " "),
      correctiveAction: "repair the TypeScript compiler configuration",
    }),
  );
}

function reportInventoryDifferences(input) {
  const configured = new Set(input.configuredFiles.map(normalizeAbsolute));
  const discovered = new Set(input.discoveredFiles.map(normalizeAbsolute));
  for (const file of [...discovered].filter((candidate) => !configured.has(candidate)).sort()) {
    input.diagnostics.push(
      createDiagnostic({
        code: "OBS_ARCH_INVENTORY",
        path: relativePosix(input.rootDir, file),
        ruleId: "COMPLETE_SOURCE_INVENTORY",
        message: `The recursive Observer inventory contains a production file omitted by ${input.compilerConfig}.`,
        correctiveAction: "make the compiler inventory include every Observer production module",
      }),
    );
  }
  for (const file of [...configured].filter((candidate) => !discovered.has(candidate)).sort()) {
    input.diagnostics.push(
      createDiagnostic({
        code: "OBS_ARCH_INVENTORY",
        path: relativePosix(input.rootDir, file),
        ruleId: "COMPLETE_SOURCE_INVENTORY",
        message: `The compiler inventory includes a file absent from the recursive Observer production inventory.`,
        correctiveAction: "align the compiler and recursive production inventories",
      }),
    );
  }
}

function collectDeclarationsAndMarkers(input) {
  const groups = new Map();
  const nodeToGroup = new Map();
  for (const sourceFile of input.sourceFiles.values()) {
    const path = relativePosix(input.rootDir, sourceFile.fileName);
    const declarations = topLevelDeclarationDescriptors(sourceFile, path);
    for (const descriptor of declarations) {
      let group = groups.get(descriptor.key);
      if (group === undefined) {
        group = {
          key: descriptor.key,
          path,
          sourceFile,
          name: descriptor.name,
          kind: descriptor.kind,
          namespace: descriptor.namespace,
          exported: descriptor.exported,
          nodes: [],
          nameNodes: [],
          markerComments: [],
          marker: undefined,
        };
        groups.set(group.key, group);
      }
      group.exported ||= descriptor.exported;
      group.nodes.push(descriptor.node);
      group.nameNodes.push(descriptor.nameNode);
      nodeToGroup.set(descriptor.node, group);
      if (ts.isVariableDeclaration(descriptor.node))
        nodeToGroup.set(descriptor.node.parent.parent, group);
    }
  }

  for (const file of input.allTypeScriptFiles) {
    const normalized = normalizeAbsolute(file);
    const sourceFile =
      input.sourceFiles.get(normalized) ??
      ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
    const comments = architectureJSDocComments(sourceFile);
    if (comments.length === 0) continue;
    attachAndValidateMarkers({
      sourceFile,
      comments,
      groups,
      nodeToGroup,
      rootDir: input.rootDir,
      diagnostics: input.diagnostics,
    });
  }

  const controlled = [];
  for (const group of groups.values()) {
    const markerComments = group.markerComments;
    if (markerComments.length === 0) continue;
    const canonicalNode = [...group.nodes].sort((left, right) => left.pos - right.pos)[0];
    const onNoncanonicalOverload = markerComments.some(
      (entry) =>
        ts.isFunctionDeclaration(entry.attachedNode) && entry.attachedNode !== canonicalNode,
    );
    const validComments = markerComments.filter((entry) => entry.parsed.valid);
    const distinctRoles = new Set(validComments.map((entry) => entry.parsed.role));
    if (onNoncanonicalOverload) {
      const entry = markerComments.find(
        (candidate) =>
          ts.isFunctionDeclaration(candidate.attachedNode) &&
          candidate.attachedNode !== canonicalNode,
      );
      input.diagnostics.push(
        markerDiagnostic({
          sourceFile: group.sourceFile,
          comment: entry.comment,
          path: group.path,
          declaration: group.name,
          message: "Only the first exported overload declaration may carry a controlled marker.",
          correctiveAction: "move the single marker to the first exported overload",
        }),
      );
    }
    if (markerComments.length > 1) {
      const conflicting = distinctRoles.size > 1;
      const entry = markerComments[1];
      input.diagnostics.push(
        markerDiagnostic({
          sourceFile: group.sourceFile,
          comment: entry.comment,
          path: group.path,
          declaration: group.name,
          message: conflicting
            ? "Overloads or declaration parts carry conflicting controlled markers."
            : "A declaration carries multiple controlled markers.",
          correctiveAction: "retain one controlled marker on the canonical declaration",
        }),
      );
    }
    if (
      !onNoncanonicalOverload &&
      markerComments.length === 1 &&
      validComments.length === 1 &&
      group.exported &&
      isProductionSourcePath(group.sourceFile.fileName, input.rootDir)
    ) {
      const parsed = validComments[0].parsed;
      group.marker = { role: parsed.role, purpose: parsed.purpose };
      controlled.push({
        path: group.path,
        name: group.name,
        kind: group.kind,
        role: parsed.role,
        purpose: parsed.purpose,
        group,
      });
    }
  }

  const symbolToGroups = new Map();
  for (const group of groups.values()) {
    for (const nameNode of group.nameNodes) {
      const symbol = input.checker.getSymbolAtLocation(nameNode);
      if (symbol === undefined) continue;
      const existing = symbolToGroups.get(symbol) ?? [];
      if (!existing.includes(group)) existing.push(group);
      symbolToGroups.set(symbol, existing);
    }
  }
  return { groups, nodeToGroup, symbolToGroups, controlled };
}

function attachAndValidateMarkers(input) {
  const declarationCandidates = allDeclarationCandidates(input.sourceFile);
  const candidateRanges = input.comments.map((comment) => [comment.start, comment.end]);
  for (const comment of input.comments) {
    const attached = declarationCandidates.find((candidate) => {
      if (candidate.start < comment.end) return false;
      let between = input.sourceFile.text.slice(comment.end, candidate.start);
      for (const [start, end] of candidateRanges) {
        if (start < comment.end || end > candidate.start) continue;
        const relativeStart = start - comment.end;
        const relativeEnd = end - comment.end;
        between = `${between.slice(0, relativeStart)}${" ".repeat(relativeEnd - relativeStart)}${between.slice(relativeEnd)}`;
      }
      return /^\s*$/.test(between);
    });
    const path = relativePosix(input.rootDir, input.sourceFile.fileName);
    if (attached === undefined) {
      input.diagnostics.push(
        markerDiagnostic({
          sourceFile: input.sourceFile,
          comment,
          path,
          declaration: "<orphan>",
          message:
            "A controlled or marker-like JSDoc is not immediately attached to a declaration.",
          correctiveAction:
            "attach one valid marker to a named top-level exported production declaration",
        }),
      );
      continue;
    }
    const descriptors = attached.descriptors;
    const group = descriptors.length === 1 ? input.nodeToGroup.get(descriptors[0].node) : undefined;
    const production = isProductionSourcePath(input.sourceFile.fileName, input.rootDir);
    if (!attached.topLevel || !production || descriptors.length !== 1 || group === undefined) {
      input.diagnostics.push(
        markerDiagnostic({
          sourceFile: input.sourceFile,
          comment,
          path,
          declaration: descriptors[0]?.name ?? "<unsupported>",
          message: "Controlled markers support only named top-level production declarations.",
          correctiveAction:
            "remove the marker or move the architectural seam to a supported declaration",
        }),
      );
      continue;
    }
    if (!group.exported) {
      input.diagnostics.push(
        markerDiagnostic({
          sourceFile: input.sourceFile,
          comment,
          path,
          declaration: group.name,
          message: "A controlled marker is attached to a non-exported declaration.",
          correctiveAction: "remove the marker or export the consequential architectural seam",
        }),
      );
      continue;
    }
    const parsed = parseArchitectureMarker(comment.lines);
    if (!parsed.valid) {
      input.diagnostics.push(
        markerDiagnostic({
          sourceFile: input.sourceFile,
          comment,
          path,
          declaration: group.name,
          message: parsed.message,
          correctiveAction:
            "use the exact marker, one blank JSDoc line, and a nonempty purpose paragraph",
        }),
      );
    }
    group.markerComments.push({ comment, parsed, attachedNode: attached.node });
  }
}

function parseArchitectureMarker(lines) {
  const content = [...lines];
  while (content[0]?.trim() === "") content.shift();
  while (content.at(-1)?.trim() === "") content.pop();
  const first = content[0]?.trim() ?? "";
  if (!roleSet.has(first)) {
    return {
      valid: false,
      message: `Malformed or unknown controlled marker ${JSON.stringify(first)}.`,
    };
  }
  if (content[1]?.trim() !== "") {
    return {
      valid: false,
      message: `Controlled marker ${first} must be followed by a blank JSDoc line.`,
    };
  }
  const paragraph = [];
  for (const line of content.slice(2)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("@")) break;
    paragraph.push(trimmed);
  }
  const purpose = paragraph.join(" ");
  if (purpose.length === 0) {
    return {
      valid: false,
      message: `Controlled marker ${first} is missing its application-purpose paragraph.`,
    };
  }
  const markerLines = content.filter((line) => roleSet.has(line.trim()));
  if (markerLines.length > 1) {
    return {
      valid: false,
      message: "One JSDoc block contains multiple controlled markers.",
    };
  }
  return { valid: true, role: first, purpose };
}

function architectureJSDocComments(sourceFile) {
  const comments = [];
  for (const match of sourceFile.text.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    const start = match.index;
    const end = start + match[0].length;
    const lines = match[1].split(/\r?\n/).map((line) => line.replace(/^\s*\*? ?/, ""));
    const content = [...lines];
    while (content[0]?.trim() === "") content.shift();
    const first = content[0]?.trim() ?? "";
    const upper = first.toUpperCase();
    const normalized = upper
      .replace(/[[\]:_-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const combinedRoles = first.split(/\s*(?:\/|\+|&|,)\s*/).map((part) =>
      part
        .toUpperCase()
        .replace(/[[\]:_-]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    const markerLike =
      roleSet.has(first) ||
      roles.includes(normalized) ||
      (combinedRoles.length > 1 && combinedRoles.every((role) => roleSet.has(role))) ||
      /^[A-Z][A-Z ]+$/.test(first);
    if (markerLike) comments.push({ start, end, lines, first });
  }
  return comments;
}

function topLevelDeclarationDescriptors(sourceFile, path) {
  return sourceFile.statements.flatMap((statement) =>
    declarationDescriptors(statement, sourceFile, path, true),
  );
}

function allDeclarationCandidates(sourceFile) {
  const candidates = [];
  const visit = (node) => {
    const descriptors = declarationDescriptors(
      node,
      sourceFile,
      sourceFile.fileName,
      node.parent === sourceFile,
    );
    if (descriptors.length > 0 || isAnonymousDeclarationNode(node)) {
      candidates.push({
        node,
        start: node.getStart(sourceFile),
        topLevel: node.parent === sourceFile,
        descriptors,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return candidates.sort((left, right) => left.start - right.start);
}

function declarationDescriptors(node, sourceFile, path, topLevel) {
  if (ts.isVariableStatement(node)) {
    let declarationKind = "var";
    if ((node.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      declarationKind = "const";
    } else if ((node.declarationList.flags & ts.NodeFlags.Let) !== 0) {
      declarationKind = "let";
    }
    return node.declarationList.declarations
      .filter((declaration) => ts.isIdentifier(declaration.name))
      .map((declaration) =>
        declarationDescriptor({
          node: declaration,
          nameNode: declaration.name,
          kind: declarationKind,
          namespace: "value",
          statement: node,
          sourceFile,
          path,
          topLevel,
        }),
      );
  }
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isClassDeclaration(node) &&
    !ts.isInterfaceDeclaration(node) &&
    !ts.isTypeAliasDeclaration(node) &&
    !ts.isEnumDeclaration(node) &&
    !ts.isModuleDeclaration(node)
  ) {
    return [];
  }
  if (node.name === undefined || !ts.isIdentifier(node.name)) return [];
  let kind;
  let namespace;
  if (ts.isFunctionDeclaration(node)) {
    kind = "function";
    namespace = "value";
  } else if (ts.isClassDeclaration(node)) {
    kind = "class";
    namespace = "both";
  } else if (ts.isInterfaceDeclaration(node)) {
    kind = "interface";
    namespace = "type";
  } else if (ts.isTypeAliasDeclaration(node)) {
    kind = "type";
    namespace = "type";
  } else if (ts.isEnumDeclaration(node)) {
    kind = "enum";
    namespace = "both";
  } else {
    kind = "namespace";
    namespace = "both";
  }
  return [
    declarationDescriptor({
      node,
      nameNode: node.name,
      kind,
      namespace,
      statement: node,
      sourceFile,
      path,
      topLevel,
    }),
  ];
}

function declarationDescriptor(input) {
  const exported =
    input.topLevel &&
    input.statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true;
  const position = input.node.getStart(input.sourceFile);
  return {
    ...input,
    name: input.nameNode.text,
    exported,
    key: `${input.path}#${input.nameNode.text}:${input.kind}`,
    position,
  };
}

function isAnonymousDeclarationNode(node) {
  return (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name === undefined;
}

function collectPublicDeclarationGroups(input) {
  const result = new Map();
  for (const sourceFile of input.sourceFiles.values()) {
    const path = relativePosix(input.rootDir, sourceFile.fileName);
    if (!path.startsWith(`${input.sourceRoot}/`)) continue;
    const moduleSymbol = input.checker.getSymbolAtLocation(sourceFile);
    const exports = [];
    if (moduleSymbol !== undefined) {
      for (const exportedSymbol of input.checker.getExportsOfModule(moduleSymbol)) {
        const target = resolveAliasSymbol(input.checker, exportedSymbol);
        const targetGroups = input.declarationState.symbolToGroups.get(target) ?? [];
        if (targetGroups.length === 0) {
          const declarations = target.declarations ?? exportedSymbol.declarations ?? [];
          for (const declaration of declarations) {
            const kind = declarationKind(declaration);
            if (kind === undefined) continue;
            exports.push({
              name: exportedSymbol.getName(),
              kind,
              role: null,
              purpose: null,
              sourcePosition: declaration.pos,
            });
          }
          continue;
        }
        for (const group of targetGroups) {
          exports.push({
            name: exportedSymbol.getName(),
            kind: group.kind,
            role: group.marker?.role ?? null,
            purpose: group.marker?.purpose ?? null,
            sourcePosition: group.nodes[0]?.pos ?? 0,
          });
        }
      }
    }
    const deduplicated = new Map();
    for (const entry of exports) {
      const key = `${entry.name}:${entry.kind}`;
      const current = deduplicated.get(key);
      if (current === undefined || entry.sourcePosition < current.sourcePosition) {
        deduplicated.set(key, entry);
      }
    }
    result.set(path, {
      exports: [...deduplicated.values()]
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.kind.localeCompare(right.kind) ||
            left.sourcePosition - right.sourcePosition,
        )
        .map(({ sourcePosition: _sourcePosition, ...entry }) => entry),
    });
  }
  return result;
}

function deriveDeclarationDependencies(input) {
  const dependencies = new Map();
  const importMetadata = new Map();
  for (const group of input.declarationState.groups.values()) {
    if (!importMetadata.has(group.path)) {
      importMetadata.set(group.path, importedSymbolMetadata(group.sourceFile, input.checker));
    }
  }
  for (const group of input.declarationState.groups.values()) {
    if (group.marker === undefined && !group.path.startsWith(`${input.sourceRoot}/`)) continue;
    // Reachability follows private helpers only, so a marked root cannot exempt an unrelated exported sibling.
    const found = new Map();
    const visitedHelpers = new Set();
    const visitGroup = (current) => {
      if (visitedHelpers.has(current.key)) return;
      visitedHelpers.add(current.key);
      for (const node of current.nodes) {
        const visit = (child) => {
          if (ts.isIdentifier(child)) {
            const symbol = input.checker.getSymbolAtLocation(child);
            if (symbol !== undefined) {
              const targetSymbol = resolveAliasSymbol(input.checker, symbol);
              const targetGroups = input.declarationState.symbolToGroups.get(targetSymbol) ?? [];
              const typePosition = isTypePosition(child);
              const matchingTargets = targetGroups.filter((target) =>
                typePosition ? target.namespace !== "value" : target.namespace !== "type",
              );
              for (const target of matchingTargets) {
                if (target.key === group.key) continue;
                if (target.path === group.path && target.marker === undefined && !target.exported) {
                  visitGroup(target);
                  continue;
                }
                if (target.marker === undefined) continue;
                const metadata = importMetadataForReference(
                  child,
                  symbol,
                  importMetadata.get(group.path),
                  input.checker,
                );
                let edgeKind = metadata?.edgeKind ?? (typePosition ? "type-only" : "runtime");
                if (target.path === group.path) {
                  edgeKind = typePosition ? "type-only" : "runtime";
                }
                const position = lineAndColumn(group.sourceFile, child.getStart(group.sourceFile));
                const key = `${target.key}:${edgeKind}`;
                if (!found.has(key)) {
                  found.set(key, {
                    target,
                    edgeKind,
                    relationship: declarationDependencyRelationship(child, group),
                    symbol: child.text,
                    ...position,
                  });
                }
              }
            }
          }
          ts.forEachChild(child, visit);
        };
        visit(node);
      }
    };
    visitGroup(group);
    dependencies.set(
      group.key,
      [...found.values()].sort(
        (left, right) =>
          left.target.path.localeCompare(right.target.path) ||
          left.target.name.localeCompare(right.target.name) ||
          left.edgeKind.localeCompare(right.edgeKind),
      ),
    );
  }
  return dependencies;
}

function declarationDependencyRelationship(identifier, group) {
  let current = identifier;
  while (current.parent !== undefined && current.parent !== group.sourceFile) {
    current = current.parent;
    if (!ts.isFunctionDeclaration(current)) continue;
    if (!group.nodes.includes(current) || current.type === undefined) return undefined;
    return current.type.pos <= identifier.pos && identifier.end <= current.type.end
      ? "declared-return"
      : undefined;
  }
  return undefined;
}

function importedSymbolMetadata(sourceFile, checker) {
  const metadata = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) {
      setImportMetadata(
        metadata,
        checker,
        clause.name,
        clause.isTypeOnly ? "type-only" : "runtime",
      );
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      setImportMetadata(
        metadata,
        checker,
        bindings.name,
        clause.isTypeOnly ? "type-only" : "runtime",
      );
      continue;
    }
    for (const element of bindings.elements) {
      setImportMetadata(
        metadata,
        checker,
        element.name,
        clause.isTypeOnly || element.isTypeOnly ? "type-only" : "runtime",
      );
    }
  }
  return metadata;
}

function setImportMetadata(metadata, checker, name, edgeKind) {
  const symbol = checker.getSymbolAtLocation(name);
  if (symbol !== undefined) metadata.set(symbol, { edgeKind });
}

function importMetadataForReference(node, symbol, metadata, checker) {
  const direct = metadata?.get(symbol);
  if (direct !== undefined) return direct;
  let current = node;
  while (
    current.parent !== undefined &&
    (ts.isPropertyAccessExpression(current.parent) || ts.isQualifiedName(current.parent))
  ) {
    current = current.parent;
  }
  const leftmost = leftmostIdentifier(current);
  if (leftmost === undefined) return undefined;
  const leftmostSymbol = checker.getSymbolAtLocation(leftmost);
  return leftmostSymbol === undefined ? undefined : metadata?.get(leftmostSymbol);
}

function leftmostIdentifier(node) {
  let current = node;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  while (ts.isQualifiedName(current)) current = current.left;
  return ts.isIdentifier(current) ? current : undefined;
}

function evaluateRoleDirections(input) {
  for (const group of input.declarationState.groups.values()) {
    if (group.marker === undefined) continue;
    const dependencies = input.dependencyState.get(group.key) ?? [];
    for (const dependency of dependencies) {
      const targetRole = dependency.target.marker?.role;
      if (targetRole === undefined) continue;
      const originRole = group.marker?.role;
      if (targetRole === "COMPOSITION ROOT" && originRole !== "COMPOSITION ROOT") {
        input.diagnostics.push(
          directionDiagnostic({
            group,
            dependency,
            ruleId: "NO_COMPOSITION_INWARD_DEPENDENCIES",
            message: "Only composition roots may depend on another composition root.",
            correctiveAction: "move wiring outward or depend on the inward application seam",
          }),
        );
        continue;
      }
      if (originRole === undefined || originRole === "COMPOSITION ROOT") continue;
      if (
        originRole === "USE CASE" &&
        targetRole === "DRIVING PORT" &&
        dependency.relationship === "declared-return" &&
        group.path === dependency.target.path
      ) {
        continue;
      }
      if (!allowedRoleTargets.get(originRole)?.has(targetRole)) {
        input.diagnostics.push(
          directionDiagnostic({
            group,
            dependency,
            ruleId: "CONTROLLED_ROLE_DIRECTION",
            message: `${originRole} declarations may not depend on ${targetRole} declarations.`,
            correctiveAction: "invert the dependency through an allowed port, policy, or use case",
          }),
        );
      }
    }
  }
}

function directionDiagnostic(input) {
  return createDiagnostic({
    code: "OBS_ARCH_DIRECTION",
    path: input.group.path,
    line: input.dependency.line,
    column: input.dependency.column,
    declaration: input.group.name,
    role: input.group.marker?.role,
    edgeKind: input.dependency.edgeKind,
    symbol: input.dependency.symbol,
    targetPath: input.dependency.target.path,
    targetDeclaration: input.dependency.target.name,
    targetRole: input.dependency.target.marker?.role,
    ruleId: input.ruleId,
    message: input.message,
    correctiveAction: input.correctiveAction,
  });
}

function analyzeModuleImports(input) {
  const path = relativePosix(input.rootDir, input.sourceFile.fileName);
  const edges = [];
  const addEdge = (specifier, edgeKind, bindings, node) => {
    const resolvedModule = resolveModuleSpecifier(
      specifier,
      input.sourceFile.fileName,
      input.compilerOptions,
    );
    const position = lineAndColumn(input.sourceFile, node.getStart(input.sourceFile));
    let targetAbsolute;
    let resolvedPath = specifier;
    let external = true;
    if (resolvedModule !== undefined && !isNodeModulesPath(resolvedModule.resolvedFileName)) {
      targetAbsolute = normalizeAbsolute(resolvedModule.resolvedFileName);
      resolvedPath = relativePosix(input.rootDir, targetAbsolute);
      external = !isPathInside(input.rootDir, targetAbsolute);
    }
    const localLike = specifier.startsWith(".") || specifier.startsWith("/");
    const workspaceLike = specifier.startsWith("@station/");
    if ((localLike || workspaceLike) && (resolvedModule === undefined || external)) {
      input.diagnostics.push(
        createDiagnostic({
          code: "OBS_ARCH_RESOLUTION",
          path,
          ...position,
          edgeKind,
          symbol: bindings.join(", ") || "module",
          targetPath: specifier,
          ruleId: "RESOLVABLE_PRODUCTION_EDGES",
          message: `The production source edge ${specifier} did not resolve to checked-in source.`,
          correctiveAction: "repair the source alias, package export, or relative module path",
        }),
      );
    }
    if (workspaceLike) {
      validateWorkspaceImport({
        specifier,
        path,
        position,
        edgeKind,
        packageExports: input.packageExports,
        diagnostics: input.diagnostics,
      });
    }
    edges.push({
      specifier,
      resolvedPath,
      edgeKind,
      bindings: [...bindings].sort(),
      targetAbsolute,
      external,
      ...position,
    });
  };

  for (const statement of input.sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause === undefined) {
        addEdge(specifier, "runtime", [], statement);
        continue;
      }
      const grouped = { runtime: [], "type-only": [] };
      if (clause.name !== undefined) {
        grouped[clause.isTypeOnly ? "type-only" : "runtime"].push("default");
      }
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        grouped[clause.isTypeOnly ? "type-only" : "runtime"].push(`* as ${bindings.name.text}`);
      }
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          const display =
            imported === element.name.text ? imported : `${imported} as ${element.name.text}`;
          grouped[clause.isTypeOnly || element.isTypeOnly ? "type-only" : "runtime"].push(display);
        }
      }
      if (grouped.runtime.length > 0) addEdge(specifier, "runtime", grouped.runtime, statement);
      if (grouped["type-only"].length > 0) {
        addEdge(specifier, "type-only", grouped["type-only"], statement);
      }
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression !== undefined &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      addEdge(
        statement.moduleReference.expression.text,
        statement.isTypeOnly ? "type-only" : "runtime",
        [statement.name.text],
        statement,
      );
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const grouped = { runtime: [], "type-only": [] };
      if (statement.exportClause === undefined) {
        grouped[statement.isTypeOnly ? "type-only" : "runtime"].push("*");
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        grouped[statement.isTypeOnly ? "type-only" : "runtime"].push(
          `* as ${statement.exportClause.name.text}`,
        );
      } else {
        for (const element of statement.exportClause.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          const display =
            imported === element.name.text ? imported : `${imported} as ${element.name.text}`;
          grouped[statement.isTypeOnly || element.isTypeOnly ? "type-only" : "runtime"].push(
            display,
          );
        }
      }
      if (grouped.runtime.length > 0) {
        addEdge(statement.moduleSpecifier.text, "runtime", grouped.runtime, statement);
      }
      if (grouped["type-only"].length > 0) {
        addEdge(statement.moduleSpecifier.text, "type-only", grouped["type-only"], statement);
      }
    }
  }

  const visit = (node) => {
    if (ts.isImportTypeNode(node)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteral(literal)) {
        addEdge(literal.text, "type-only", ["import()"], node);
      } else {
        reportNonliteralEdge(input.sourceFile, path, node, "type-only", input.diagnostics);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
          addEdge(argument.text, "runtime", [], node);
        } else {
          reportNonliteralEdge(input.sourceFile, path, node, "runtime", input.diagnostics);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(input.sourceFile, visit);
  return { path, sourceFile: input.sourceFile, edges };
}

function reportNonliteralEdge(sourceFile, path, node, edgeKind, diagnostics) {
  const position = lineAndColumn(sourceFile, node.getStart(sourceFile));
  diagnostics.push(
    createDiagnostic({
      code: "OBS_ARCH_DYNAMIC",
      path,
      ...position,
      edgeKind,
      symbol: "dynamic module",
      targetPath: "<nonliteral>",
      ruleId: "RESOLVABLE_PRODUCTION_EDGES",
      message: "Observer production uses a nonliteral dynamic import or require edge.",
      correctiveAction:
        "replace it with a literal module specifier that the source graph can resolve",
    }),
  );
}

function validateWorkspaceImport(input) {
  const packageName = workspacePackageName(input.specifier);
  const exports = input.packageExports.get(packageName);
  const subpath =
    input.specifier === packageName ? "." : `.${input.specifier.slice(packageName.length)}`;
  const valid = exports !== undefined && packageExportAllows(exports, subpath);
  if (valid) return;
  input.diagnostics.push(
    createDiagnostic({
      code: "OBS_ARCH_WORKSPACE_EXPORT",
      path: input.path,
      ...input.position,
      edgeKind: input.edgeKind,
      symbol: "module",
      targetPath: input.specifier,
      ruleId: "WORKSPACE_EXPORTS_MATCH_ALIASES",
      message: `The source alias ${input.specifier} is not backed by a matching workspace package export.`,
      correctiveAction: "align tsconfig.base.json source aliases with the owning package exports",
    }),
  );
}

function collectWorkspacePackageExports(rootDir) {
  const packages = new Map();
  for (const scanRoot of scanRoots) {
    for (const packageFile of walkNamedFiles(resolve(rootDir, scanRoot), "package.json")) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(packageFile, "utf8"));
      } catch {
        continue;
      }
      if (typeof parsed.name === "string") packages.set(parsed.name, parsed.exports);
    }
  }
  return packages;
}

function packageExportAllows(exports, subpath) {
  if (typeof exports === "string" || Array.isArray(exports)) return subpath === ".";
  if (exports === null || typeof exports !== "object") return false;
  const keys = Object.keys(exports);
  if (keys.every((key) => !key.startsWith("."))) return subpath === ".";
  if (Object.hasOwn(exports, subpath)) return true;
  return keys.some((key) => {
    if (!key.includes("*")) return false;
    const [prefix, suffix = ""] = key.split("*");
    return subpath.startsWith(prefix) && subpath.endsWith(suffix);
  });
}

function evaluatePathRules(input) {
  const integrationsRoot = resolve(input.rootDir, "integrations");
  const commandsRoot = resolve(input.rootDir, `${input.sourceRoot}/commands`);
  const providersRoot = resolve(input.rootDir, `${input.sourceRoot}/providers`);
  const protocolRoot = resolve(input.rootDir, "packages/protocol/src");
  for (const module of input.moduleAnalyses) {
    const sourceAbsolute = normalizeAbsolute(module.sourceFile.fileName);
    for (const edge of module.edges) {
      if (
        edge.targetAbsolute !== undefined &&
        isPathInside(integrationsRoot, edge.targetAbsolute)
      ) {
        input.diagnostics.push(
          pathRuleDiagnostic({
            code: "OBS_ARCH_INTEGRATION",
            module,
            edge,
            ruleId: "OBSERVER_PROVIDER_NEUTRALITY",
            message: "Observer production may not depend on a concrete integration.",
            correctiveAction: "inject the provider contract from outer composition",
          }),
        );
      }
      if (
        (edge.specifier === "@station/protocol" ||
          (edge.targetAbsolute !== undefined && isPathInside(protocolRoot, edge.targetAbsolute))) &&
        module.path !== `${input.sourceRoot}/runtime/server.ts`
      ) {
        input.diagnostics.push(
          pathRuleDiagnostic({
            code: "OBS_ARCH_PROTOCOL",
            module,
            edge,
            ruleId: "OBSERVER_PROTOCOL_SERVER_ONLY",
            message: "Observer protocol dependencies are confined to runtime/server.ts.",
            correctiveAction:
              "depend on application contracts or move transport translation to runtime/server.ts",
          }),
        );
      }
      if (
        isPathInside(providersRoot, sourceAbsolute) &&
        edge.targetAbsolute !== undefined &&
        isPathInside(commandsRoot, edge.targetAbsolute)
      ) {
        input.diagnostics.push(
          pathRuleDiagnostic({
            code: "OBS_ARCH_PROVIDER_COMMAND",
            module,
            edge,
            ruleId: "PROVIDER_COMMAND_ISOLATION",
            message: "Observer provider aggregation may not import command orchestration.",
            correctiveAction: "move application orchestration into a use case or composition root",
          }),
        );
      }
      if (
        edge.specifier === "@station/testing" ||
        (edge.targetAbsolute !== undefined &&
          !isProductionSourcePath(edge.targetAbsolute, input.rootDir))
      ) {
        input.diagnostics.push(
          pathRuleDiagnostic({
            code: "OBS_ARCH_TEST_DEPENDENCY",
            module,
            edge,
            ruleId: "NO_PRODUCTION_TEST_DEPENDENCIES",
            message: "Observer production may not depend on test, support, or fixture modules.",
            correctiveAction:
              "move the production contract inward and keep substitutes in test code",
          }),
        );
      }
    }
  }
}

function pathRuleDiagnostic(input) {
  return createDiagnostic({
    code: input.code,
    path: input.module.path,
    line: input.edge.line,
    column: input.edge.column,
    edgeKind: input.edge.edgeKind,
    symbol: input.edge.bindings.join(", ") || "module",
    targetPath: input.edge.resolvedPath,
    ruleId: input.ruleId,
    message: input.message,
    correctiveAction: input.correctiveAction,
  });
}

function evaluateCycles(input) {
  const modules = new Map(input.moduleAnalyses.map((module) => [module.path, module]));
  const adjacency = new Map();
  for (const module of input.moduleAnalyses) {
    adjacency.set(
      module.path,
      module.edges
        .filter((edge) => modules.has(edge.resolvedPath))
        .map((edge) => edge.resolvedPath),
    );
  }
  const components = stronglyConnectedComponents([...modules.keys()].sort(), adjacency);
  for (const component of components) {
    const members = new Set(component);
    const internalEdges = component
      .flatMap((path) =>
        (modules.get(path)?.edges ?? [])
          .filter((edge) => members.has(edge.resolvedPath))
          .map((edge) => ({ path, edge })),
      )
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) || compareImportEdges(left.edge, right.edge),
      );
    const cyclic =
      component.length > 1 || internalEdges.some(({ path, edge }) => path === edge.resolvedPath);
    if (!cyclic) continue;
    const cycle = internalEdges.map(({ path, edge }) => ({
      path,
      targetPath: edge.resolvedPath,
      edgeKind: edge.edgeKind,
      specifier: edge.specifier,
    }));
    for (const { path, edge } of internalEdges) {
      input.diagnostics.push(
        createDiagnostic({
          code: "OBS_ARCH_CYCLE",
          path,
          line: edge.line,
          column: edge.column,
          edgeKind: edge.edgeKind,
          symbol: edge.bindings.join(", ") || "module",
          targetPath: edge.resolvedPath,
          ruleId: "NO_PRODUCTION_CYCLES",
          message: `Observer production cycle contains ${component.join(", ")}.`,
          correctiveAction:
            "move the shared contract to its inward purpose owner and remove the back edge",
          cycle,
        }),
      );
    }
  }
}

function stronglyConnectedComponents(nodes, adjacency) {
  let nextIndex = 0;
  const indexes = new Map();
  const lowlinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (node) => {
    indexes.set(node, nextIndex);
    lowlinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowlinks.set(node, Math.min(lowlinks.get(node), lowlinks.get(target)));
      } else if (onStack.has(target)) {
        lowlinks.set(node, Math.min(lowlinks.get(node), indexes.get(target)));
      }
    }
    if (lowlinks.get(node) !== indexes.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  };
  for (const node of nodes) if (!indexes.has(node)) visit(node);
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

function resolveModuleSpecifier(specifier, containingFile, compilerOptions) {
  return ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule;
}

function resolveAliasSymbol(checker, symbol) {
  let current = symbol;
  const visited = new Set();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !visited.has(current)) {
    visited.add(current);
    const target = checker.getAliasedSymbol(current);
    if (target === current) break;
    current = target;
  }
  return current;
}

function isTypePosition(node) {
  let current = node;
  while (current.parent !== undefined) {
    current = current.parent;
    if (ts.isTypeNode(current)) return true;
    if (
      ts.isExpressionStatement(current) ||
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isCallExpression(current) ||
      ts.isNewExpression(current)
    ) {
      return false;
    }
  }
  return false;
}

function declarationKind(declaration) {
  if (ts.isFunctionDeclaration(declaration)) return "function";
  if (ts.isClassDeclaration(declaration)) return "class";
  if (ts.isInterfaceDeclaration(declaration)) return "interface";
  if (ts.isTypeAliasDeclaration(declaration)) return "type";
  if (ts.isEnumDeclaration(declaration)) return "enum";
  if (ts.isModuleDeclaration(declaration)) return "namespace";
  if (ts.isVariableDeclaration(declaration)) {
    const list = declaration.parent;
    if ((list.flags & ts.NodeFlags.Const) !== 0) return "const";
    if ((list.flags & ts.NodeFlags.Let) !== 0) return "let";
    return "var";
  }
  return undefined;
}

function serializeManifest(manifest) {
  const expanded = `${JSON.stringify(manifest, null, 2)}\n`;
  // Match the repository formatter's primitive-array layout so lint and byte-staleness checks share one canonical form.
  return expanded.replace(
    /^(\s*)"bindings": \[\n([\s\S]*?)^\1\]/gm,
    (matched, indentation, body) => {
      const compactValues = body
        .trim()
        .split("\n")
        .map((line) => line.trim().replace(/,$/, ""))
        .join(", ");
      const compact = `${indentation}"bindings": [${compactValues}]`;
      return compact.length <= 100 ? compact : matched;
    },
  );
}

function publicImportEdge(edge) {
  return {
    specifier: edge.specifier,
    resolvedPath: edge.resolvedPath,
    edgeKind: edge.edgeKind,
    bindings: edge.bindings,
  };
}

function publicDependencyTarget(dependency) {
  return `${dependency.path}#${dependency.declaration}:${dependency.kind}:${dependency.role}:${dependency.edgeKind}`;
}

function compareDependencies(left, right) {
  return publicDependencyTarget(left).localeCompare(publicDependencyTarget(right));
}

function compareControlledDeclarations(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    left.declaration.localeCompare(right.declaration) ||
    left.kind.localeCompare(right.kind)
  );
}

function compareImportEdges(left, right) {
  return (
    left.resolvedPath.localeCompare(right.resolvedPath) ||
    left.specifier.localeCompare(right.specifier) ||
    left.edgeKind.localeCompare(right.edgeKind) ||
    left.bindings.join("\0").localeCompare(right.bindings.join("\0"))
  );
}

function compareDiagnostics(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code) ||
    (left.declaration ?? "").localeCompare(right.declaration ?? "") ||
    (left.targetPath ?? "").localeCompare(right.targetPath ?? "") ||
    (left.targetDeclaration ?? "").localeCompare(right.targetDeclaration ?? "")
  );
}

function createDiagnostic(input) {
  return {
    code: input.code,
    path: input.path,
    line: input.line ?? 1,
    column: input.column ?? 1,
    declaration: input.declaration,
    role: input.role,
    edgeKind: input.edgeKind,
    symbol: input.symbol,
    targetPath: input.targetPath,
    targetDeclaration: input.targetDeclaration,
    targetRole: input.targetRole,
    ruleId: input.ruleId,
    message: input.message,
    correctiveAction: input.correctiveAction,
    cycle: input.cycle,
  };
}

function markerDiagnostic(input) {
  const position = lineAndColumn(input.sourceFile, input.comment.start);
  return createDiagnostic({
    code: "OBS_ARCH_MARKER",
    path: input.path,
    ...position,
    declaration: input.declaration,
    ruleId: "VALID_CONTROLLED_MARKER",
    message: input.message,
    correctiveAction: input.correctiveAction,
  });
}

function lineAndColumn(sourceFile, position) {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function walkTypeScriptFiles(root) {
  return walkFiles(root, (name) => /\.(?:ts|tsx|mts|cts)$/.test(name));
}

function walkNamedFiles(root, expectedName) {
  return walkFiles(root, (name) => name === expectedName);
}

function walkFiles(root, includeFile) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (ignoredDirectoryNames.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path, includeFile));
    else if (includeFile(entry.name)) files.push(normalizeAbsolute(path));
  }
  return files.sort();
}

function isProductionSourcePath(file, rootDir) {
  const path = relativePosix(rootDir, file);
  if (!/\.(?:ts|tsx|mts|cts)$/.test(path) || /\.d\.(?:ts|mts|cts)$/.test(path)) {
    return false;
  }
  if (!path.split("/").includes("src")) return false;
  if (/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(path)) return false;
  return !path.split("/").some((part) => testPathParts.has(part));
}

function normalizeAbsolute(path) {
  return resolve(path);
}

function relativePosix(root, path) {
  return relative(root, path).split(sep).join("/");
}

function isNodeModulesPath(path) {
  return normalizeAbsolute(path).split(sep).includes("node_modules");
}

function isPathInside(root, candidate) {
  const relation = relative(normalizeAbsolute(root), normalizeAbsolute(candidate));
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

function workspacePackageName(specifier) {
  return specifier.split("/").slice(0, 2).join("/");
}

function parseCliArguments(argv) {
  const options = { write: false, format: "text", rootDir: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") options.write = true;
    else if (argument === "--format=json") options.format = "json";
    else if (argument === "--root") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--root requires a path");
      options.rootDir = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function runCli() {
  let options;
  try {
    options = parseCliArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const result = options.write
    ? writeObserverArchitectureManifest({ rootDir: options.rootDir })
    : checkObserverArchitecture({ rootDir: options.rootDir });
  if (options.format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.diagnostics.length === 0,
          manifestPath: result.manifestPath,
          diagnostics: result.diagnostics,
        },
        null,
        2,
      )}\n`,
    );
  } else if (result.diagnostics.length > 0) {
    for (const diagnostic of result.diagnostics) {
      process.stderr.write(`${formatArchitectureDiagnostic(diagnostic)}\n`);
    }
  } else if (options.write) {
    process.stdout.write(`Wrote ${result.manifestPath}.\n`);
  } else {
    process.stdout.write(
      `Observer architecture is conformant (${result.manifest.modules.length} modules); ${result.manifestPath} is current.\n`,
    );
  }
  if (result.diagnostics.length > 0) process.exitCode = 1;
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) runCli();
