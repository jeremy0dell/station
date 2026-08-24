// Station production remains provider-neutral; dashboard coupling inventories are temporary #168 debt.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// TypeScript 7 has no stable compiler API, so AST checks use its official TS6 compatibility package.
import ts from "@typescript/typescript6";

const STATION_VIEW_ROOT = fileURLToPath(new URL(".", import.meta.url));
const STATION_SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONTEXT_MENU_ROOT = fileURLToPath(new URL("../contextMenu/", import.meta.url));
const STATION_SOURCES_ROOT = fileURLToPath(new URL("../sources/", import.meta.url));
const DASHBOARD_CORE_SOURCE_ROOT = fileURLToPath(
  new URL("../../../packages/dashboard-core/src/", import.meta.url),
);
const DASHBOARD_OPERATIONS_ROOT = join(DASHBOARD_CORE_SOURCE_ROOT, "state/operations");
const LINKED_STATION_PACKAGES = new Set([
  "cli",
  "client",
  "config",
  "contracts",
  "dashboard-core",
  "host",
  "observability",
  "observer",
  "protocol",
  "runtime",
  "terminal",
]);
const LINKED_STATION_VIEW_PACKAGES = new Set([
  "client",
  "config",
  "contracts",
  "dashboard-core",
  "runtime",
]);
const TEST_ONLY_DIRECTORIES = new Set(["fixtures", "test", "testing", "__fixtures__", "__tests__"]);
const DASHBOARD_CORE_ROOT_IMPORT = "@station/dashboard-core";
const PRIVATE_DASHBOARD_STATE_TYPES = new Set([
  "AddProjectFlowState",
  "DashboardState",
  "NewSessionFlowState",
  "TuiLocalRows",
  "TuiScreen",
  "TuiViewState",
]);
const DASHBOARD_CORE_INTERNAL_PATHS = [
  "@station/dashboard-core/state/runtime",
  "@station/dashboard-core/state/operations",
] as const;

type SourceModule = Readonly<{
  filePath: string;
  relativePath: string;
  sourceFile: ts.SourceFile;
}>;

type ModuleReference = Readonly<{
  kind: "dynamic import" | "export" | "import" | "type import";
  specifier: string;
  importedNames: readonly string[];
}>;

type ImportBinding = Readonly<{
  importedName: string;
  localName: string;
  specifier: string;
}>;

type DirectDashboardMutationInventory = Readonly<
  Record<string, Readonly<{ receiver: string; transitions: readonly string[] }>>
>;

const SOURCE_FILE_CACHE = new Map<string, ts.SourceFile>();
const MODULE_REFERENCE_CACHE = new WeakMap<ts.SourceFile, ModuleReference[]>();

function relativeSourcePath(root: string, filePath: string): string {
  return relative(root, filePath).replaceAll("\\", "/");
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files.sort();
}

function parseSourceModule(filePath: string, root: string): SourceModule {
  let sourceFile = SOURCE_FILE_CACHE.get(filePath);
  if (sourceFile === undefined) {
    const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    sourceFile = ts.createSourceFile(
      filePath,
      readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
    SOURCE_FILE_CACHE.set(filePath, sourceFile);
  }
  return {
    filePath,
    relativePath: relativeSourcePath(root, filePath),
    sourceFile,
  };
}

function sourceModules(
  root: string,
  include: (relativePath: string) => boolean = () => true,
): SourceModule[] {
  return sourceFiles(root).flatMap((filePath) => {
    const relativePath = relativeSourcePath(root, filePath);
    return include(relativePath) ? [parseSourceModule(filePath, root)] : [];
  });
}

function isProductionSource(relativePath: string): boolean {
  if (/\.(?:test|spec)\.tsx?$/.test(relativePath) || relativePath.endsWith(".d.ts")) {
    return false;
  }
  return !relativePath.split("/").some((part) => TEST_ONLY_DIRECTORIES.has(part));
}

function importedNamesOfImport(node: ts.ImportDeclaration): string[] {
  const names: string[] = [];
  const clause = node.importClause;
  if (clause === undefined) return names;
  if (clause.name !== undefined) names.push("default");
  if (clause.namedBindings === undefined) return names;
  if (ts.isNamespaceImport(clause.namedBindings)) {
    names.push("*");
  } else {
    for (const element of clause.namedBindings.elements) {
      names.push((element.propertyName ?? element.name).text);
    }
  }
  return names;
}

function importedNamesOfExport(node: ts.ExportDeclaration): string[] {
  if (node.exportClause === undefined) return ["*"];
  if (ts.isNamespaceExport(node.exportClause)) return ["*"];
  return node.exportClause.elements.map((element) => (element.propertyName ?? element.name).text);
}

function staticModuleReferenceOf(statement: ts.Statement): ModuleReference | undefined {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
    return {
      kind: "import",
      specifier: statement.moduleSpecifier.text,
      importedNames: importedNamesOfImport(statement),
    };
  }
  if (
    !ts.isExportDeclaration(statement) ||
    statement.moduleSpecifier === undefined ||
    !ts.isStringLiteralLike(statement.moduleSpecifier)
  ) {
    return undefined;
  }
  return {
    kind: "export",
    specifier: statement.moduleSpecifier.text,
    importedNames: importedNamesOfExport(statement),
  };
}

function dynamicImportReferenceOf(node: ts.Node): ModuleReference | undefined {
  if (
    !ts.isCallExpression(node) ||
    node.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    node.arguments.length !== 1 ||
    !ts.isStringLiteralLike(node.arguments[0]!)
  ) {
    return undefined;
  }
  return {
    kind: "dynamic import",
    specifier: node.arguments[0].text,
    importedNames: ["*"],
  };
}

function importTypeReferenceOf(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): ModuleReference | undefined {
  if (
    !ts.isImportTypeNode(node) ||
    !ts.isLiteralTypeNode(node.argument) ||
    !ts.isStringLiteralLike(node.argument.literal)
  ) {
    return undefined;
  }
  return {
    kind: "type import",
    specifier: node.argument.literal.text,
    importedNames: [node.qualifier?.getText(sourceFile) ?? "*"],
  };
}

function moduleReferencesOf(module: SourceModule): ModuleReference[] {
  const cached = MODULE_REFERENCE_CACHE.get(module.sourceFile);
  if (cached !== undefined) return cached;
  const references = module.sourceFile.statements.flatMap((statement) => {
    const reference = staticModuleReferenceOf(statement);
    return reference === undefined ? [] : [reference];
  });
  const visit = (node: ts.Node): void => {
    const reference =
      dynamicImportReferenceOf(node) ?? importTypeReferenceOf(module.sourceFile, node);
    if (reference !== undefined) references.push(reference);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(module.sourceFile, visit);
  MODULE_REFERENCE_CACHE.set(module.sourceFile, references);
  return references;
}

function importBindingsOf(module: SourceModule): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const statement of module.sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.importClause === undefined
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause.name !== undefined) {
      bindings.push({ importedName: "default", localName: clause.name.text, specifier });
    }
    if (clause.namedBindings === undefined) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push({ importedName: "*", localName: clause.namedBindings.name.text, specifier });
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      bindings.push({
        importedName: (element.propertyName ?? element.name).text,
        localName: element.name.text,
        specifier,
      });
    }
  }
  return bindings;
}

function hasExportModifier(statement: ts.Statement): boolean {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function exportedDeclarationName(statement: ts.Statement): string | undefined {
  switch (statement.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.ModuleDeclaration: {
      const declaration = statement as
        | ts.ClassDeclaration
        | ts.EnumDeclaration
        | ts.FunctionDeclaration
        | ts.InterfaceDeclaration
        | ts.ModuleDeclaration
        | ts.TypeAliasDeclaration;
      return declaration.name !== undefined && ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : undefined;
    }
    default:
      return undefined;
  }
}

function exportedNamesOfStatement(statement: ts.Statement): string[] {
  if (ts.isExportDeclaration(statement)) {
    return statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((element) => element.name.text)
      : [];
  }
  if (!hasExportModifier(statement)) return [];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  const name = exportedDeclarationName(statement);
  return name === undefined ? [] : [name];
}

function exportedNamesOf(module: SourceModule): string[] {
  return module.sourceFile.statements.flatMap(exportedNamesOfStatement);
}

function dashboardRuntimeInternalExports(): ReadonlySet<string> {
  const operationModules = sourceModules(DASHBOARD_OPERATIONS_ROOT);
  const names = new Set(operationModules.flatMap((module) => exportedNamesOf(module)));
  // TuiFocusTarget is a normalized renderer-control contract, not an operation implementation.
  names.delete("TuiFocusTarget");
  return names;
}

function referenceDescriptors(
  module: SourceModule,
  reference: ModuleReference,
  importedNames?: readonly string[],
): string[] {
  const names =
    importedNames ??
    (reference.importedNames.length > 0 ? reference.importedNames : ["(side effect)"]);
  return names.map(
    (name) =>
      `${module.relativePath}: ${reference.kind} ${name} from ${reference.specifier}`,
  );
}

function mutableStoreReferenceInventory(module: SourceModule): {
  count: number;
  unexpected: string[];
} {
  const bindings = importBindingsOf(module);
  const storeApiNames = new Set(
    bindings
      .filter(
        (binding) =>
          binding.specifier === "zustand/vanilla" && binding.importedName === "StoreApi",
      )
      .map((binding) => binding.localName),
  );
  const tuiStoreNames = new Set(
    bindings
      .filter(
        (binding) =>
          binding.specifier.startsWith(DASHBOARD_CORE_ROOT_IMPORT) &&
          binding.importedName === "TuiStore",
      )
      .map((binding) => binding.localName),
  );
  let count = 0;
  const unexpected: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      storeApiNames.has(node.typeName.text)
    ) {
      const [stateType] = node.typeArguments ?? [];
      if (
        node.typeArguments?.length === 1 &&
        stateType !== undefined &&
        ts.isTypeReferenceNode(stateType) &&
        ts.isIdentifier(stateType.typeName) &&
        tuiStoreNames.has(stateType.typeName.text)
      ) {
        count += 1;
      } else {
        unexpected.push(`${module.relativePath}: ${node.getText(module.sourceFile)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(module.sourceFile, visit);
  return { count, unexpected };
}

function setStateCallDescriptor(module: SourceModule, node: ts.CallExpression): string | undefined {
  let receiver: ts.Expression | undefined;
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "setState") {
    receiver = node.expression.expression;
  } else if (
    ts.isElementAccessExpression(node.expression) &&
    node.expression.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.expression.argumentExpression) &&
    node.expression.argumentExpression.text === "setState"
  ) {
    receiver = node.expression.expression;
  }
  if (receiver === undefined) return undefined;
  const [nextState] = node.arguments;
  const transition =
    nextState !== undefined && ts.isCallExpression(nextState)
      ? nextState.expression.getText(module.sourceFile)
      : nextState === undefined
        ? "(missing argument)"
        : ts.SyntaxKind[nextState.kind];
  return `${module.relativePath}: ${receiver.getText(module.sourceFile)}.setState(${transition})`;
}

function directSetStateCalls(modules: readonly SourceModule[]): string[] {
  const calls: string[] = [];
  for (const module of modules) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const descriptor = setStateCallDescriptor(module, node);
        if (descriptor !== undefined) calls.push(descriptor);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(module.sourceFile, visit);
  }
  return calls.sort();
}

function isDashboardInternalPath(specifier: string): boolean {
  return DASHBOARD_CORE_INTERNAL_PATHS.some(
    (path) => specifier === path || specifier.startsWith(`${path}/`),
  );
}

function isProhibitedStationImport(specifier: string): boolean {
  if (
    specifier.includes("apps/tui") ||
    specifier === "ink" ||
    specifier.startsWith("ink/") ||
    /(^|\/)providers?(\/|$)/.test(specifier) ||
    /(^|\/)integrations?(\/|$)/.test(specifier)
  ) {
    return true;
  }
  if (!specifier.startsWith("@station/")) return false;
  const packageName = specifier.split("/")[1] ?? "";
  return !LINKED_STATION_PACKAGES.has(packageName);
}

const PRODUCTION_MODULES = sourceModules(STATION_SOURCE_ROOT, isProductionSource);
const DASHBOARD_RUNTIME_INTERNAL_EXPORTS = dashboardRuntimeInternalExports();

// #168 descendants may delete entries from these inventories; additions require architecture review.
const RAW_DASHBOARD_STORE_MODULES = [] as const;
const MUTABLE_STORE_REFERENCE_INVENTORY: Readonly<Record<string, number>> = {};
const DIRECT_DASHBOARD_MUTATION_INVENTORY: DirectDashboardMutationInventory = {};
const DASHBOARD_RUNTIME_IMPORT_INVENTORY = [
  "app/types.ts: import DashboardRuntime from @station/dashboard-core/runtime",
  "station/store/dashboardRuntime.ts: import DashboardRuntime from @station/dashboard-core/runtime",
] as const;
const DASHBOARD_INTERNAL_IMPORT_INVENTORY = [] as const;
const OPENTUI_LAYOUT_GEOMETRY_NAMES = new Set([
  "BaseRenderable",
  "BoxRenderable",
  "Renderable",
  "ScrollBoxRenderable",
  "Yoga",
]);
const DASHBOARD_TEXT_NAMES = new Set([
  "cellWidth",
  "clipCells",
  "textCellUnits",
  "truncateCells",
]);
const OPENTUI_LAYOUT_GEOMETRY_OWNERS = new Set([
  "contextMenu/usePointerAnchoredMenuPlacement.ts",
  "station/view/layout/SemanticScrollViewport.tsx",
  "station/view/layout/renderBoxInsets.ts",
  "station/view/layout/scrollViewport.ts",
  "station/view/layout/semanticPointerTarget.ts",
  "station/view/layout/useAncestorBoundedHeight.ts",
  "station/view/layout/useAnchoredMenuPlacement.ts",
]);
const TERMINAL_INTEGRATION_IMPORT_INVENTORY = [
  "main.tsx: import ensureStationHostRunning from @station/terminal",
] as const;

describe("station production boundaries", () => {
  it("finds every production layer and excludes test support", () => {
    const paths = new Set(PRODUCTION_MODULES.map((module) => module.relativePath));
    const expectedProduction = [
      "main.tsx",
      "dashboardRenderer/main.tsx",
      "sources/observerStationClient.ts",
      "config/tuiConfig.ts",
      "input/stationInput.ts",
      "station/view/DashboardView.tsx",
    ];
    const expectedExcluded = [
      "station/importBoundaries.test.ts",
      "station/test/support/makeStationTestRuntime.ts",
      "sources/fixtures/mockObserverSnapshot.ts",
      "terminal/testing/frameProbe.ts",
    ];
    const expectedInternalExports = ["createTuiLocalOperationRunner"];
    expect(expectedProduction.filter((path) => !paths.has(path))).toEqual([]);
    expect(expectedExcluded.filter((path) => paths.has(path))).toEqual([]);
    expect(
      expectedInternalExports.filter((name) => !DASHBOARD_RUNTIME_INTERNAL_EXPORTS.has(name)),
    ).toEqual([]);
  });

  it("uses only linked packages and never imports apps/tui, ink, providers, or integrations", () => {
    const failures = PRODUCTION_MODULES.flatMap((module) =>
      moduleReferencesOf(module).flatMap((reference) =>
        isProhibitedStationImport(reference.specifier)
          ? referenceDescriptors(module, reference)
          : [],
      ),
    ).sort();
    expect(failures).toEqual([]);
  });

  it("confines the terminal integration to native composition", () => {
    const imports = PRODUCTION_MODULES.flatMap((module) =>
      moduleReferencesOf(module).flatMap((reference) =>
        reference.specifier === "@station/terminal"
          ? referenceDescriptors(module, reference)
          : [],
      ),
    ).sort();
    expect(imports).toEqual([...TERMINAL_INTEGRATION_IMPORT_INVENTORY].sort());
  });

  it("keeps the Station client-source tree independent of dashboard-core", () => {
    const failures = sourceModules(STATION_SOURCES_ROOT, isProductionSource).flatMap((module) =>
      moduleReferencesOf(module).flatMap((reference) =>
        reference.specifier.startsWith(DASHBOARD_CORE_ROOT_IMPORT)
          ? referenceDescriptors(module, reference)
          : [],
      ),
    );
    expect(failures.sort()).toEqual([]);
  });

  it("keeps Zustand React access read-only and rejects raw store imports", () => {
    const rawImports: string[] = [];
    const invalidReactImports: string[] = [];
    for (const module of PRODUCTION_MODULES) {
      for (const reference of moduleReferencesOf(module)) {
        if (reference.specifier === "zustand/react") {
          const invalidNames =
            reference.importedNames.length > 0
              ? reference.importedNames.filter((name) => name !== "useStore")
              : ["(side effect)"];
          invalidReactImports.push(...referenceDescriptors(module, reference, invalidNames));
        } else if (
          reference.specifier === "zustand" ||
          reference.specifier.startsWith("zustand/")
        ) {
          rawImports.push(...referenceDescriptors(module, reference));
        }
      }
    }
    const expectedRawImports = RAW_DASHBOARD_STORE_MODULES.map(
      (path) => `${path}: import StoreApi from zustand/vanilla`,
    ).sort();
    expect(invalidReactImports.sort()).toEqual([]);
    expect(rawImports.sort()).toEqual(expectedRawImports);
  });

  it("rejects TuiStore imports and mutable StoreApi references", () => {
    const tuiStoreImports: string[] = [];
    const actualReferences: Record<string, number> = {};
    const unexpectedReferences: string[] = [];
    for (const module of PRODUCTION_MODULES) {
      for (const reference of moduleReferencesOf(module)) {
        if (!reference.specifier.startsWith(DASHBOARD_CORE_ROOT_IMPORT)) continue;
        const tuiStoreNames = reference.importedNames.filter((name) => name === "TuiStore");
        tuiStoreImports.push(...referenceDescriptors(module, reference, tuiStoreNames));
      }
      const inventory = mutableStoreReferenceInventory(module);
      if (inventory.count > 0) actualReferences[module.relativePath] = inventory.count;
      unexpectedReferences.push(...inventory.unexpected);
    }
    const expectedTuiStoreImports = RAW_DASHBOARD_STORE_MODULES.map(
      (path) => `${path}: import TuiStore from @station/dashboard-core`,
    ).sort();
    expect(actualReferences).toEqual(MUTABLE_STORE_REFERENCE_INVENTORY);
    expect(tuiStoreImports.sort()).toEqual(expectedTuiStoreImports);
    expect(unexpectedReferences.sort()).toEqual([]);
  });

  it("rejects private mutable dashboard state models", () => {
    const failures = PRODUCTION_MODULES.flatMap((module) =>
      moduleReferencesOf(module).flatMap((reference) => {
        if (!reference.specifier.startsWith(DASHBOARD_CORE_ROOT_IMPORT)) {
          return [];
        }
        const mutableNames = reference.importedNames.filter((name) =>
          PRIVATE_DASHBOARD_STATE_TYPES.has(name),
        );
        return referenceDescriptors(module, reference, mutableNames);
      }),
    ).sort();
    expect(failures).toEqual([]);
  });

  it("prohibits direct dashboard store mutations", () => {
    const expected = Object.entries(DIRECT_DASHBOARD_MUTATION_INVENTORY)
      .flatMap(([path, inventory]) =>
        inventory.transitions.map(
          (transition) => `${path}: ${inventory.receiver}.setState(${transition})`,
        ),
      )
      .sort();
    expect(directSetStateCalls(PRODUCTION_MODULES)).toEqual(expected);
  });

  it("freezes imports of the full dashboard runtime and operation internals", () => {
    const runtimeImports: string[] = [];
    const internalImports: string[] = [];
    for (const module of PRODUCTION_MODULES) {
      for (const reference of moduleReferencesOf(module)) {
        if (isDashboardInternalPath(reference.specifier)) {
          internalImports.push(...referenceDescriptors(module, reference));
          continue;
        }
        if (
          reference.specifier !== DASHBOARD_CORE_ROOT_IMPORT &&
          reference.specifier !== "@station/dashboard-core/runtime"
        )
          continue;
        const runtimeNames = reference.importedNames.filter((name) => name === "DashboardRuntime");
        runtimeImports.push(...referenceDescriptors(module, reference, runtimeNames));
        const internalNames = reference.importedNames.filter((name) =>
          DASHBOARD_RUNTIME_INTERNAL_EXPORTS.has(name),
        );
        internalImports.push(...referenceDescriptors(module, reference, internalNames));
      }
    }
    expect(runtimeImports.sort()).toEqual([...DASHBOARD_RUNTIME_IMPORT_INVENTORY].sort());
    expect(internalImports.sort()).toEqual([...DASHBOARD_INTERNAL_IMPORT_INVENTORY].sort());
  });

  it("only reaches dashboard-core through role entrypoints", () => {
    const violations: string[] = [];
    for (const module of PRODUCTION_MODULES) {
      for (const reference of moduleReferencesOf(module)) {
        if (!reference.specifier.startsWith(DASHBOARD_CORE_ROOT_IMPORT)) continue;
        const isRoleEntrypoint =
          reference.specifier === "@station/dashboard-core/runtime" ||
          reference.specifier === "@station/dashboard-core/state" ||
          reference.specifier === "@station/dashboard-core/selectors" ||
          reference.specifier === "@station/dashboard-core/text" ||
          reference.specifier === "@station/dashboard-core/widgets";
        if (!isRoleEntrypoint) {
          violations.push(...referenceDescriptors(module, reference));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("uses the shared terminal-cell text contract", () => {
    const failures = PRODUCTION_MODULES.flatMap((module) =>
      moduleReferencesOf(module).flatMap((reference) => {
        if (reference.specifier === "string-width") {
          return referenceDescriptors(module, reference);
        }
        if (reference.specifier === "@station/dashboard-core/selectors") {
          const misplacedNames = reference.importedNames.filter((name) =>
            DASHBOARD_TEXT_NAMES.has(name),
          );
          return referenceDescriptors(module, reference, misplacedNames);
        }
        return [];
      }),
    );
    expect(failures.sort()).toEqual([]);
  });

  it("confines OpenTUI layout geometry to named renderer-boundary modules", () => {
    const owners = new Set<string>();
    const violations: string[] = [];
    for (const module of PRODUCTION_MODULES) {
      for (const reference of moduleReferencesOf(module)) {
        if (reference.specifier !== "@opentui/core") continue;
        const geometryNames = reference.importedNames.filter((name) =>
          OPENTUI_LAYOUT_GEOMETRY_NAMES.has(name),
        );
        if (geometryNames.length === 0 || module.relativePath.startsWith("terminal/")) continue;
        owners.add(module.relativePath);
        if (!OPENTUI_LAYOUT_GEOMETRY_OWNERS.has(module.relativePath)) {
          violations.push(...referenceDescriptors(module, reference, geometryNames));
        }
      }
    }
    expect(violations.sort()).toEqual([]);
    expect([...owners].sort()).toEqual([...OPENTUI_LAYOUT_GEOMETRY_OWNERS].sort());
  });
});

describe("station view import boundaries", () => {
  const modules = sourceModules(STATION_VIEW_ROOT);
  const files = modules.map((module) => module.filePath);

  it("finds the station tree", () => {
    const relFiles = new Set(modules.map((module) => module.relativePath));
    expect(relFiles.has("StationOverlay.tsx")).toBe(true);
    expect(relFiles.has("input/stationOverlayLayer.ts")).toBe(true);
    expect(relFiles.has("view/DashboardView.tsx")).toBe(true);
  });

  it("never imports from apps/tui or ink", () => {
    const failures: string[] = [];
    for (const module of modules) {
      for (const reference of moduleReferencesOf(module)) {
        if (
          reference.specifier.includes("apps/tui") ||
          reference.specifier === "ink" ||
          reference.specifier.startsWith("ink/")
        ) {
          failures.push(`${module.relativePath} imports ${reference.specifier}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("only uses dashboard-facing @station packages provided by the link script", () => {
    const failures: string[] = [];
    for (const module of modules) {
      for (const reference of moduleReferencesOf(module)) {
        if (!reference.specifier.startsWith("@station/")) continue;
        const packageName = reference.specifier.split("/")[1] ?? "";
        if (!LINKED_STATION_VIEW_PACKAGES.has(packageName)) {
          failures.push(`${module.relativePath} imports ${reference.specifier}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("does not carry a local ported dashboard fork", () => {
    const failures = modules
      .map((module) => module.relativePath)
      .filter((path) => path.startsWith("ported/"));
    expect(failures).toEqual([]);
  });

  it("never sets the focusable prop (the coordination store owns focus)", () => {
    const failures: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".tsx")) continue;
      const source = readFileSync(file, "utf8");
      if (/\bfocusable\s*[=:]/.test(source) && !/focusable:\s*false/.test(source)) {
        failures.push(relativeSourcePath(STATION_VIEW_ROOT, file));
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps sheet action sizing and pointer wiring in shared controls", () => {
    const frame = "view/sheets/BottomSheetFrameView.tsx";
    const primitives = "view/sheets/parts.tsx";
    const actionSheets = new Set([
      "view/sheets/AddProjectSheetView.tsx",
      "view/sheets/ForkSessionSheetView.tsx",
      "view/sheets/NewSessionSheetView.tsx",
      "view/sheets/RenameSessionSheetView.tsx",
    ]);
    const failures: string[] = [];
    for (const file of files) {
      const rel = relativeSourcePath(STATION_VIEW_ROOT, file);
      if (
        !rel.startsWith("view/sheets/") ||
        !file.endsWith(".tsx") ||
        file.includes(".test.") ||
        rel === primitives
      ) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      const reasons: string[] = [];
      if (actionSheets.has(rel) && !/<SheetButtonRow(?:\s|\/?>)/.test(source)) {
        reasons.push("omits shared action buttons");
      }
      if (/<SheetButton(?:\s|\/?>)/.test(source)) reasons.push("uses low-level SheetButton");
      if (rel !== frame && /\bstationMouseProps\s*\(/.test(source)) {
        reasons.push("calls stationMouseProps");
      }
      if (rel !== frame && /\bonMouse(?:Over|Out|Down|Up|Move|Drag)\s*=/.test(source)) {
        reasons.push("declares mouse handlers");
      }
      if (reasons.length > 0) failures.push(`${rel}: ${reasons.join(", ")}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("context menu import boundaries", () => {
  const modules = sourceModules(CONTEXT_MENU_ROOT);

  it("finds the context menu tree", () => {
    const relFiles = new Set(modules.map((module) => module.relativePath));
    expect(relFiles.has("ContextMenuRoot.tsx")).toBe(true);
    expect(relFiles.has("items.ts")).toBe(true);
    expect(relFiles.has("placement.ts")).toBe(true);
  });

  it("never imports from apps/tui, ink, providers, or integrations", () => {
    const failures: string[] = [];
    for (const module of modules) {
      for (const reference of moduleReferencesOf(module)) {
        if (isProhibitedStationImport(reference.specifier)) {
          failures.push(`${module.relativePath} imports ${reference.specifier}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
