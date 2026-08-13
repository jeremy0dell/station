import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
// TypeScript 7 has no stable compiler API, so AST diagnostics use its official TS6 compatibility package.
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";

const roots = ["apps", "packages", "integrations"];
const providerNeutralSourceRoots = [
  "packages/contracts/src",
  "packages/dashboard-core/src",
  "packages/observability/src",
  "packages/protocol/src",
  "packages/runtime/src",
];

const observerPersistenceBundleAllowlist = new Set([
  "apps/observer/src/persistence/ports.ts",
  "apps/observer/src/persistence/sqliteAdapter.ts",
  "apps/observer/src/runtime/api.ts",
  "apps/observer/src/runtime/main.ts",
]);

const observerNoSqliteLane = [
  "apps/observer/src/persistence/observationParser.ts",
  "apps/observer/test/integration/in-memory-observer-api.test.ts",
  "apps/observer/test/integration/in-memory-persistence-ports.test.ts",
  "apps/observer/test/support/inMemoryObserverPersistence.ts",
  "apps/observer/test/support/observerPersistenceContract.ts",
];

const observerSqliteHandleAllowlist = new Set([
  "apps/observer/src/persistence/sqliteAdapter.ts",
  "apps/observer/src/runtime/main.ts",
  "apps/observer/src/sqlite.ts",
]);

const tmuxImplementationMarkers = [
  "@station/tmux",
  "display-popup",
  "@station_popup",
  "@station_tui_dev",
  "STATION_FOCUS_PROVIDER=tmux",
  "STATION_TMUX_BIN",
];

// Every raw timer exception needs a reason here so new timeout plumbing stays intentional.
const setTimeoutAllowlist = new Map([
  [
    "apps/observer/src/runtime/main.ts",
    "Shutdown backstop and final exit timers keep a stopped Observer process from lingering.",
  ],
  [
    "packages/dashboard-core/src/state/operations/failedCreateExpiry.ts",
    "A single earliest-deadline timer schedules local failed-row expiry, isolated from observer command timeout plumbing.",
  ],
  [
    "packages/dashboard-core/src/state/runtimeEffectScope.ts",
    "The dashboard-owned timer registry cancels local UI scheduling during disposal before draining admitted effects.",
  ],
  [
    "packages/dashboard-core/src/state/runtime.ts",
    "Visible Add Project directory polling is a TUI-local filesystem refresh, not observer command timeout or retry plumbing.",
  ],
  [
    "apps/cli/src/commands/tui.ts",
    "Short popup-mode startup defer lets the TUI render a cached snapshot before requesting a nonblocking reconcile.",
  ],
  [
    "apps/observer/src/metadata/gitRefInvalidation.ts",
    "Short debounce coalesces noisy Git ref watch events before requesting an observer-owned metadata reconcile.",
  ],
  [
    "packages/dashboard-core/src/widgets/useTopRowWidgets.ts",
    "Header widgets use a TUI-local minute-boundary timer for display text, not observer command timeout or retry plumbing.",
  ],
  [
    "packages/station-host/src/client.ts",
    "Station host requests use per-request socket timeouts at the host protocol boundary, outside shared observer runtime helpers.",
  ],
  [
    "apps/observer/src/runtime/observerReap.ts",
    "Explicit SIGTERM and SIGKILL grace delays are operator-authorized OS process timing, not command timeout or retry plumbing.",
  ],
  [
    "apps/cli/src/observerProcess/startup.ts",
    "UI-only progress timers report a runtime-bounded observer launch; they do not implement startup timeout or retry control.",
  ],
]);

const setIntervalAllowlist = new Map([
  [
    "packages/dashboard-core/src/widgets/useTopRowWidgets.ts",
    "Header widgets use local render refresh intervals for clock/weather text, isolated from observer runtime IO.",
  ],
  [
    "apps/observer/src/runtime/socketOwnership.ts",
    "Socket takeover by another observer (unlink+rebind) emits no fs event to the displaced process; inode polling is the only loss signal.",
  ],
]);

describe("boundary inventory guard", () => {
  it("keeps timeout and retry plumbing inside explicit runtime boundaries", async () => {
    const files = await sourceFiles();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const path = relative(process.cwd(), file);

      if (source.includes("Promise.race")) {
        violations.push(`${path}: raw Promise.race`);
      }
      if (source.includes("setInterval(") && !setIntervalAllowlist.has(path)) {
        violations.push(`${path}: raw setInterval polling`);
      }
      if (source.includes("setTimeout(") && !setTimeoutAllowlist.has(path)) {
        violations.push(`${path}: raw setTimeout without allowlist reason`);
      }
      if (/while\s*\([^)]*Date\.now\(/.test(source)) {
        violations.push(`${path}: deadline loop using Date.now`);
      }
    }

    expect(violations).toEqual([]);
    expect([...setTimeoutAllowlist.values()].every((reason) => reason.length > 20)).toBe(true);
    expect([...setIntervalAllowlist.values()].every((reason) => reason.length > 20)).toBe(true);
  });

  it("keeps tmux implementation details out of provider-neutral source packages", async () => {
    const files = (
      await Promise.all(
        providerNeutralSourceRoots.map((root) => sourceFilesAt(join(process.cwd(), root))),
      )
    )
      .flat()
      .filter(isProductionSourceFile);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const path = relative(process.cwd(), file);
      for (const marker of tmuxImplementationMarkers) {
        if (source.includes(marker)) {
          violations.push(`${path}: tmux implementation marker ${marker}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps Observer logging and project configuration representations at runtime adapters", async () => {
    const files = (await sourceFilesAt(join(process.cwd(), "apps/observer/src"))).filter(
      isProductionSourceFile,
    );
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const path = relative(process.cwd(), file);
      if (
        /\b(?:JsonlLogger|createJsonlLogger)\b/.test(source) &&
        path !== "apps/observer/src/runtime/logging.ts"
      ) {
        violations.push(`${path}: concrete JSONL logger`);
      }
      if (
        /\b(?:addProjectToConfig|removeProjectFromConfig|setProjectDefaultHarnessInConfig)\b/.test(
          source,
        ) &&
        path !== "apps/observer/src/runtime/projectConfigWriter.ts"
      ) {
        violations.push(`${path}: concrete project config mutation`);
      }
      if (
        (path === "apps/observer/src/commands/project.ts" ||
          path === "apps/observer/src/commands/router.ts") &&
        /\b(?:configPath|homeDir)\b/.test(source)
      ) {
        violations.push(`${path}: configuration path plumbing`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps SQLite persistence details at the adapter and runtime composition edge", async () => {
    const files = await sourceFiles();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const path = relative(process.cwd(), file);

      if (/\bObserverPersistence\b/.test(source)) {
        violations.push(`${path}: obsolete ObserverPersistence symbol`);
      }
      if (
        /\bObserverPersistenceBundle\b/.test(source) &&
        !observerPersistenceBundleAllowlist.has(path)
      ) {
        violations.push(`${path}: ObserverPersistenceBundle outside composition`);
      }
      if (/\bObserverSqliteHandle\b/.test(source) && !observerSqliteHandleAllowlist.has(path)) {
        violations.push(`${path}: ObserverSqliteHandle outside SQLite edge`);
      }
    }

    const reconcileCorePath = join(process.cwd(), "apps/observer/src/reconcile/core.ts");
    const reconcileCore = await readFile(reconcileCorePath, "utf8");
    for (const match of reconcileCore.matchAll(/\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier?.toLowerCase().includes("sqlite")) {
        violations.push(`apps/observer/src/reconcile/core.ts: SQLite import ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps the in-memory adapter and no-SQLite composition lane independent of SQLite rows", async () => {
    const violations = new Set<string>();

    for (const path of observerNoSqliteLane) {
      for (const violation of await noSqliteImportViolations(path)) {
        violations.add(violation);
      }
    }

    expect([...violations].sort()).toEqual([]);
  });

  it("isolates local Git metadata mechanics behind application-owned ports", async () => {
    const refreshPath = join(process.cwd(), "apps/observer/src/metadata/refresh.ts");
    const portsPath = join(process.cwd(), "apps/observer/src/metadata/ports.ts");
    const runtimePath = join(process.cwd(), "apps/observer/src/runtime/api.ts");
    const refreshSource = await readFile(refreshPath, "utf8");
    const portsSource = await readFile(portsPath, "utf8");
    const runtimeSource = await readFile(runtimePath, "utf8");

    const refreshImports = sourceImports(refreshSource, refreshPath).map(
      (entry) => entry.specifier,
    );
    expect(refreshImports).toContain("./ports.js");
    expect(refreshImports).not.toEqual(
      expect.arrayContaining([
        "./gitCommand.js",
        "./gitRefInvalidation.js",
        "./localGitChangeSummary.js",
        "node:fs",
        "node:path",
        "@station/runtime/externalCommand",
      ]),
    );

    const portDeclarationNames = [
      "WorktreeMetadataTarget",
      "WorktreeChangeBaseSelection",
      "WorktreeChangeReadRequest",
      "WorktreeChangeEvidence",
      "WorktreeChangeReadResult",
      "WorktreeChangeSource",
      "WorktreeMetadataInvalidationSource",
    ];
    const portFacts = declarationFacts(portsSource, portsPath, portDeclarationNames);
    expect(portFacts.declarations).toEqual(portDeclarationNames);
    expect(portFacts.identifiers).not.toEqual(
      expect.arrayContaining([
        "path",
        "cwd",
        "ExternalCommandRunner",
        "FSWatcher",
        "WatchDirectory",
      ]),
    );

    const metadataFiles = (
      await sourceFilesAt(join(process.cwd(), "apps/observer/src/metadata"))
    ).filter(isProductionSourceFile);
    const nodeFsImporters: string[] = [];
    const commandRunnerOwners: string[] = [];
    for (const file of metadataFiles) {
      const source = await readFile(file, "utf8");
      const path = relative(process.cwd(), file);
      if (sourceImports(source, file).some((entry) => entry.specifier === "node:fs")) {
        nodeFsImporters.push(path);
      }
      if (/\bExternalCommandRunner\b/.test(source)) commandRunnerOwners.push(path);
    }
    expect(nodeFsImporters).toEqual(["apps/observer/src/metadata/gitRefInvalidation.ts"]);
    expect(commandRunnerOwners.sort()).toEqual([
      "apps/observer/src/metadata/gitCommand.ts",
      "apps/observer/src/metadata/localGitChangeSummary.ts",
    ]);

    const runtimeImports = sourceImports(runtimeSource, runtimePath).map(
      (entry) => entry.specifier,
    );
    expect(runtimeImports).toEqual(
      expect.arrayContaining([
        "../metadata/gitRefInvalidation.js",
        "../metadata/localGitChangeSummary.js",
        "../metadata/ports.js",
      ]),
    );
  });

  it("isolates local diagnostic evidence behind an application-owned port", async () => {
    const collectorPath = join(process.cwd(), "apps/observer/src/diagnostics/collector.ts");
    const portPath = join(process.cwd(), "apps/observer/src/diagnostics/evidenceSource.ts");
    const adapterPath = join(process.cwd(), "apps/observer/src/diagnostics/localEvidenceSource.ts");
    const apiPath = join(process.cwd(), "apps/observer/src/runtime/api.ts");
    const mainPath = join(process.cwd(), "apps/observer/src/runtime/main.ts");
    const [collectorSource, portSource, adapterSource, apiSource, mainSource] = await Promise.all(
      [collectorPath, portPath, adapterPath, apiPath, mainPath].map((path) =>
        readFile(path, "utf8"),
      ),
    );

    const collectorImports = sourceImports(collectorSource, collectorPath).map(
      (entry) => entry.specifier,
    );
    expect(collectorImports).toContain("./evidenceSource.js");
    expect(collectorImports).not.toEqual(
      expect.arrayContaining([
        "node:fs",
        "node:fs/promises",
        "node:path",
        "@station/observability/logger",
        "@station/observability/retention",
      ]),
    );
    expect(collectorSource).not.toMatch(
      /\b(?:readJsonlLog|scanLocalStateUsage|componentLogPath|readdir|stat)\b/,
    );

    const portImports = sourceImports(portSource, portPath).map((entry) => entry.specifier);
    expect(portImports).toEqual(["@station/contracts"]);
    expect(portSource).not.toMatch(
      /\b(?:node:fs|node:path|Persistence|ProviderRegistry|ObserverCore|Sqlite|SpoolStore)\b/,
    );

    const diagnosticsFiles = (
      await sourceFilesAt(join(process.cwd(), "apps/observer/src/diagnostics"))
    ).filter(isProductionSourceFile);
    const traversalOwners: string[] = [];
    for (const file of diagnosticsFiles) {
      const source = await readFile(file, "utf8");
      const imports = sourceImports(source, file).map((entry) => entry.specifier);
      if (
        imports.some((specifier) => specifier.startsWith("node:fs")) ||
        /\b(?:readJsonlLog|scanLocalStateUsage|readdir|stat)\b/.test(source)
      ) {
        traversalOwners.push(relative(process.cwd(), file));
      }
    }
    expect(traversalOwners).toEqual(["apps/observer/src/diagnostics/localEvidenceSource.ts"]);

    expect(sourceImports(mainSource, mainPath).map((entry) => entry.specifier)).toContain(
      "../diagnostics/localEvidenceSource.js",
    );
    expect(mainSource).toContain("createLocalDiagnosticEvidenceSource({");
    expect(sourceImports(apiSource, apiPath).map((entry) => entry.specifier)).toContain(
      "../diagnostics/evidenceSource.js",
    );
    expect(apiSource).not.toContain("localEvidenceSource");

    expect(portSource).toMatch(
      /\/\*\*[\s\S]*?\* DRIVEN PORT[\s\S]*?export interface DiagnosticEvidenceSource/,
    );
    expect(adapterSource).toMatch(
      /\/\*\*[\s\S]*?\* ADAPTER[\s\S]*?export function createLocalDiagnosticEvidenceSource/,
    );
    expect(collectorSource).toMatch(
      /\/\*\*[\s\S]*?\* USE CASE[\s\S]*?export async function collectDiagnosticSnapshot/,
    );
  });

  it("centralizes safe-error and external-command shape inspection in runtime", async () => {
    const files = await sourceFiles();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const path = relative(process.cwd(), file);
      const isRuntimeNormalization = path === "packages/runtime/src/errors.ts";

      if (!isRuntimeNormalization && /\b(?:function|const)\s+isSafeError(?:Like)?\b/.test(source)) {
        violations.push(`${path}: local SafeError guard`);
      }
      if (!isRuntimeNormalization && /\bsafeErrorCause\b/.test(source)) {
        violations.push(`${path}: local SafeError cause traversal`);
      }
      if (/\b(?:stringFieldDeep|numberFieldDeep)\b/.test(source)) {
        violations.push(`${path}: recursive arbitrary-field probing`);
      }
      if (/try\s*\{\s*throw\s+[^;]+;?\s*\}\s*catch/s.test(source)) {
        violations.push(`${path}: artificial throw/catch normalization`);
      }
      if (/diagnosticDetails\s*\?\s*:\s*unknown/.test(source)) {
        violations.push(`${path}: untyped diagnosticDetails cast`);
      }
      if (
        !path.startsWith("packages/runtime/src/") &&
        /(?:command|cwd|exitCode|signal|stdout|stderr|stdoutSnippet|stderrSnippet)\s*\?\s*:\s*unknown/.test(
          source,
        )
      ) {
        violations.push(`${path}: arbitrary external-command field inspection`);
      }
    }

    expect(violations).toEqual([]);
  });
});

async function noSqliteImportViolations(entryPath: string): Promise<string[]> {
  const entryFile = resolve(process.cwd(), entryPath);
  const queue = [entryFile];
  const visited = new Set<string>();
  const violations: string[] = [];
  const persistenceIndexPath = resolve(process.cwd(), "apps/observer/src/persistence/index");
  const rowsPath = resolve(process.cwd(), "apps/observer/src/persistence/rows");

  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const path = relative(process.cwd(), file);
    const source = await readFile(file, "utf8");

    for (const imported of sourceImports(source, file)) {
      if (file !== entryFile && !imported.runtime) continue;
      const { specifier } = imported;
      if (specifier.toLowerCase().includes("sqlite")) {
        violations.push(`${path}: SQLite import ${specifier}`);
      }
      if (
        specifier === "@station/observer/internal" ||
        /(?:^|\/)src\/internal(?:\.js)?$/.test(specifier)
      ) {
        violations.push(`${path}: src/internal import ${specifier}`);
      }
      if (!specifier.startsWith(".")) continue;

      const target = resolve(dirname(file), specifier).replace(/\.(?:js|ts|tsx)$/, "");
      if (target === persistenceIndexPath) {
        violations.push(`${path}: SQLite-reexporting persistence barrel ${specifier}`);
      }
      if (target === rowsPath) {
        violations.push(`${path}: SQLite row translation import ${specifier}`);
      }
      const targetFile = await resolveSourceModule(target);
      if (targetFile === undefined) continue;
      const targetSource = await readFile(targetFile, "utf8");
      if (/\bSqlDatabase\b/.test(targetSource)) {
        violations.push(`${path}: SQLite-backed persistence import ${specifier}`);
      }
      if (imported.runtime) queue.push(targetFile);
    }
  }

  return violations;
}

function declarationFacts(
  source: string,
  path: string,
  declarationNames: readonly string[],
): { declarations: string[]; identifiers: string[] } {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const expected = new Set(declarationNames);
  const declarations: string[] = [];
  const identifiers = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      expected.has(statement.name.text)
    ) {
      declarations.push(statement.name.text);
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) identifiers.add(node.text);
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(statement, visit);
    }
  }

  return { declarations, identifiers: [...identifiers] };
}

type SourceImport = { specifier: string; runtime: boolean };

function sourceImports(source: string, path: string): SourceImport[] {
  const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const imports: SourceImport[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push({
        specifier: statement.moduleSpecifier.text,
        runtime: importDeclarationRuns(statement),
      });
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const runtime =
        !statement.isTypeOnly &&
        (!statement.exportClause ||
          !ts.isNamedExports(statement.exportClause) ||
          statement.exportClause.elements.some((element) => !element.isTypeOnly));
      imports.push({ specifier: statement.moduleSpecifier.text, runtime });
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({ specifier: node.arguments[0].text, runtime: true });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return imports;
}

function importDeclarationRuns(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  return (
    bindings === undefined ||
    ts.isNamespaceImport(bindings) ||
    bindings.elements.length === 0 ||
    bindings.elements.some((element) => !element.isTypeOnly)
  );
}

async function resolveSourceModule(target: string): Promise<string | undefined> {
  for (const candidate of [`${target}.ts`, `${target}.tsx`, join(target, "index.ts")]) {
    if ((await readFile(candidate, "utf8").catch(() => undefined)) !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    files.push(...(await sourceFilesAt(join(process.cwd(), root))));
  }
  return files.filter((file) => isProductionSourceFile(file) && file.endsWith(".ts"));
}

async function sourceFilesAt(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? sourceFilesAt(path) : [path];
    }),
  );
  return files.flat();
}

function isProductionSourceFile(file: string): boolean {
  return (
    (file.endsWith(".ts") || file.endsWith(".tsx")) &&
    file.includes("/src/") &&
    !file.includes("/dist/") &&
    !file.endsWith(".d.ts") &&
    !file.endsWith(".test.ts") &&
    !file.endsWith(".test.tsx")
  );
}
