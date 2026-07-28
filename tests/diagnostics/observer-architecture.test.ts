import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeObserverArchitecture,
  checkObserverArchitecture,
  formatArchitectureDiagnostic,
  writeObserverArchitectureManifest,
} from "../../tools/lint/check-observer-architecture.mjs";

const fixtureRoots: string[] = [];

const validContracts = `
/**
 * DRIVING PORT
 *
 * Offers a typed request boundary to fixture actors.
 */
export interface FixtureDrivingPort {
  execute(): void;
}

/**
 * DRIVEN PORT
 *
 * Supplies persistence behavior to fixture use cases.
 */
export interface FixtureDrivenPort {
  save(): void;
}
`;

const validPolicy = `
/**
 * POLICY
 *
 * Selects a deterministic fixture value.
 */
export function selectFixtureValue(value: number): number {
  return value + 1;
}
`;

const validUseCase = `
import type { FixtureDrivenPort } from "@station/contracts";
import { selectFixtureValue } from "./policy.js";

/**
 * USE CASE
 *
 * Coordinates one fixture operation through policy and persistence seams.
 */
export function runFixtureUseCase(port: FixtureDrivenPort): number {
  port.save();
  return selectFixtureValue(1);
}
`;

const validAdapter = `
import type { FixtureDrivenPort, FixtureDrivingPort } from "@station/contracts";

/**
 * ADAPTER
 *
 * Translates fixture storage and request boundaries into local behavior.
 */
export class FixtureAdapter implements FixtureDrivenPort, FixtureDrivingPort {
  execute(): void {}
  save(): void {}
}
`;

const validFixtureFiles = {
  "packages/contracts/src/index.ts": `export type { FixtureDrivenPort, FixtureDrivingPort } from "./ports.js";`,
  "packages/contracts/src/ports.ts": validContracts,
  "apps/observer/src/policy.ts": validPolicy,
  "apps/observer/src/useCase.ts": validUseCase,
  "apps/observer/src/adapter.ts": validAdapter,
  "apps/observer/src/misc.ts": `
export interface Twin { value: string }
export const Twin = { value: "fixture" };

/**
 * USE CASE
 *
 * Applies overloaded fixture input without an external representation.
 */
export function executeFixture(value: string): string;
export function executeFixture(value: number): number;
export function executeFixture(value: string | number): string | number {
  return value;
}

export function ordinaryHelper(): string {
  return "ordinary";
}

export async function loadExternalDrivers(): Promise<void> {
  await import("bun:sqlite");
  await import("node:sqlite");
}
`,
};

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Observer architecture checker", () => {
  it("derives valid roles, aliases, barrels, external dynamics, and stable sorted inventory", async () => {
    const root = await createFixture(validFixtureFiles);

    const first = analyzeObserverArchitecture({ rootDir: root });
    const second = analyzeObserverArchitecture({ rootDir: root });

    expect(first.diagnostics).toEqual([]);
    expect(first.serializedManifest).toBe(second.serializedManifest);
    expect(first.serializedManifest).not.toContain(root);
    expect(first.manifest.modules.map((module) => module.path)).toEqual(
      [...first.manifest.modules.map((module) => module.path)].sort(),
    );

    const useCase = first.manifest.controlledDeclarations.find(
      (declaration) => declaration.declaration === "runFixtureUseCase",
    );
    expect(useCase).toMatchObject({ role: "USE CASE" });
    expect(useCase?.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ declaration: "FixtureDrivenPort", edgeKind: "type-only" }),
        expect.objectContaining({ declaration: "selectFixtureValue", edgeKind: "runtime" }),
      ]),
    );

    const miscellaneous = first.manifest.modules.find(
      (module) => module.path === "apps/observer/src/misc.ts",
    );
    expect(miscellaneous?.exports).toEqual(
      expect.arrayContaining([
        { name: "ordinaryHelper", kind: "function", role: null, purpose: null },
        { name: "Twin", kind: "interface", role: null, purpose: null },
        { name: "Twin", kind: "const", role: null, purpose: null },
      ]),
    );
    expect(
      miscellaneous?.exports.filter((entry: { name: string }) => entry.name === "executeFixture"),
    ).toHaveLength(1);
    expect(miscellaneous?.imports).toEqual(
      expect.arrayContaining([
        {
          specifier: "bun:sqlite",
          resolvedPath: "bun:sqlite",
          edgeKind: "runtime",
          bindings: [],
        },
        {
          specifier: "node:sqlite",
          resolvedPath: "node:sqlite",
          edgeKind: "runtime",
          bindings: [],
        },
      ]),
    );
  });

  it("reports forbidden outward, lateral, and type-only role dependencies with actionable fields", async () => {
    const root = await createFixture({
      "apps/observer/src/targets.ts": `
/**
 * DRIVEN PORT
 *
 * Supplies a fixture edge capability.
 */
export interface LocalDrivenPort { save(): void }

/**
 * ADAPTER
 *
 * Implements a fixture edge using local mechanics.
 */
export function createLocalAdapter(): LocalDrivenPort {
  return { save() {} };
}
`,
      "apps/observer/src/violations.ts": `
import type { LocalDrivenPort } from "./targets.js";
import { createLocalAdapter } from "./targets.js";

/**
 * POLICY
 *
 * Demonstrates a forbidden runtime dependency for diagnostics.
 */
export function forbiddenPolicy(): LocalDrivenPort {
  return createLocalAdapter();
}

/**
 * DRIVING PORT
 *
 * Demonstrates a forbidden lateral port dependency for diagnostics.
 */
export interface ForbiddenDrivingPort extends LocalDrivenPort {}
`,
    });

    const result = analyzeObserverArchitecture({ rootDir: root });
    const direction = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "OBS_ARCH_DIRECTION",
    );

    expect(direction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "apps/observer/src/violations.ts",
          declaration: "forbiddenPolicy",
          role: "POLICY",
          edgeKind: "runtime",
          targetDeclaration: "createLocalAdapter",
          targetRole: "ADAPTER",
          ruleId: "CONTROLLED_ROLE_DIRECTION",
        }),
        expect.objectContaining({
          declaration: "forbiddenPolicy",
          edgeKind: "type-only",
          targetDeclaration: "LocalDrivenPort",
        }),
        expect.objectContaining({
          declaration: "ForbiddenDrivingPort",
          edgeKind: "type-only",
          targetDeclaration: "LocalDrivenPort",
        }),
      ]),
    );
    const rendered = formatArchitectureDiagnostic(direction[0]);
    expect(rendered).toContain("apps/observer/src/violations.ts:");
    expect(rendered).toContain("[POLICY]");
    expect(rendered).toContain("violated: CONTROLLED_ROLE_DIRECTION");
    expect(rendered).toContain("apps/observer/src/targets.ts#");
  });

  it("enforces role direction from controlled seams outside Observer source", async () => {
    const root = await createFixture({
      "apps/observer/src/useCase.ts": `
/**
 * USE CASE
 *
 * Coordinates the fixture application intent.
 */
export function runFixtureUseCase(): void {}
`,
      "apps/cli/src/adapter.ts": `
import { runFixtureUseCase } from "../../observer/src/useCase.js";
/**
 * ADAPTER
 *
 * Deliberately reaches a use case from an outer boundary adapter.
 */
export function forbiddenCliAdapter(): void { runFixtureUseCase(); }
`,
    });

    const direction = analyzeObserverArchitecture({ rootDir: root }).diagnostics.filter(
      (diagnostic) => diagnostic.code === "OBS_ARCH_DIRECTION",
    );
    expect(direction).toEqual([
      expect.objectContaining({
        path: "apps/cli/src/adapter.ts",
        declaration: "forbiddenCliAdapter",
        role: "ADAPTER",
        targetDeclaration: "runFixtureUseCase",
        targetRole: "USE CASE",
        ruleId: "CONTROLLED_ROLE_DIRECTION",
      }),
    ]);
  });

  it("detects runtime and type-only source cycles with every participating edge", async () => {
    const root = await createFixture({
      "apps/observer/src/runtimeA.ts": `import { runtimeB } from "./runtimeB.js"; export const runtimeA = runtimeB;`,
      "apps/observer/src/runtimeB.ts": `import { runtimeA } from "./runtimeA.js"; export const runtimeB = runtimeA;`,
      "apps/observer/src/typeA.ts": `import type { TypeB } from "./typeB.js"; export type TypeA = { next?: TypeB };`,
      "apps/observer/src/typeB.ts": `import type { TypeA } from "./typeA.js"; export type TypeB = { next?: TypeA };`,
    });

    const cycles = analyzeObserverArchitecture({ rootDir: root }).diagnostics.filter(
      (diagnostic) => diagnostic.code === "OBS_ARCH_CYCLE",
    );

    expect(cycles.filter((diagnostic) => diagnostic.edgeKind === "runtime")).toHaveLength(2);
    expect(cycles.filter((diagnostic) => diagnostic.edgeKind === "type-only")).toHaveLength(2);
    expect(cycles.every((diagnostic) => diagnostic.cycle?.length === 2)).toBe(true);
  });

  it("rejects nonliteral dynamics while recording literal local and external dynamic imports", async () => {
    const root = await createFixture({
      "apps/observer/src/literal.ts": `export const literal = true;`,
      "apps/observer/src/dynamic.ts": `
const target = "./literal.js";
export async function load(): Promise<void> {
  await import("./literal.js");
  await import("node:sqlite");
  await import(target);
}
`,
    });

    const result = analyzeObserverArchitecture({ rootDir: root });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "OBS_ARCH_DYNAMIC",
        path: "apps/observer/src/dynamic.ts",
        edgeKind: "runtime",
        targetPath: "<nonliteral>",
      }),
    ]);
    const imports = result.manifest.modules.find(
      (module) => module.path === "apps/observer/src/dynamic.ts",
    )?.imports;
    expect(imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolvedPath: "apps/observer/src/literal.ts" }),
        expect.objectContaining({ resolvedPath: "node:sqlite" }),
      ]),
    );
  });

  it("narrows composition-root reachability to private wiring and checks unrelated exports", async () => {
    const root = await createFixture({
      "apps/observer/src/adapter.ts": `
/**
 * ADAPTER
 *
 * Implements fixture composition mechanics.
 */
export function createFixtureAdapter(): object { return {}; }
`,
      "apps/observer/src/composition.ts": `
import { createFixtureAdapter } from "./adapter.js";

function wireFixture(): object {
  return createFixtureAdapter();
}

/**
 * COMPOSITION ROOT
 *
 * Selects and wires the fixture adapter.
 */
export function composeFixture(): object {
  return wireFixture();
}

/**
 * POLICY
 *
 * Demonstrates that a sibling export receives no composition exemption.
 */
export function unrelatedPolicy(): object {
  return createFixtureAdapter();
}
`,
    });

    const direction = analyzeObserverArchitecture({ rootDir: root }).diagnostics.filter(
      (diagnostic) => diagnostic.code === "OBS_ARCH_DIRECTION",
    );
    expect(direction).toEqual([
      expect.objectContaining({
        declaration: "unrelatedPolicy",
        targetDeclaration: "createFixtureAdapter",
      }),
    ]);
  });

  it("excludes test support from the graph but rejects production imports and controlled test markers", async () => {
    const root = await createFixture({
      "apps/observer/src/main.ts": `import { fakeValue } from "../test/support/fake.js"; export const value = fakeValue;`,
      "apps/observer/test/support/fake.ts": `
/**
 * ADAPTER
 *
 * Must not classify a test substitute as production architecture.
 */
export class FakeAdapter {}
export const fakeValue = 1;
`,
    });

    const result = analyzeObserverArchitecture({ rootDir: root });
    expect(result.manifest.modules.map((module) => module.path)).not.toContain(
      "apps/observer/test/support/fake.ts",
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "OBS_ARCH_TEST_DEPENDENCY" }),
        expect.objectContaining({ code: "OBS_ARCH_MARKER" }),
      ]),
    );
  });

  it("validates malformed, duplicate, unsupported, orphan, and overload markers without requiring ordinary markers", async () => {
    const root = await createFixture({
      "apps/observer/src/markers.ts": `
/** SERVICE */
export function unknownRole(): void {}

/** [ADAPTER] */
export function bracketRole(): void {}

/**
 * POLICY
 * Missing the blank line.
 */
export function missingBlank(): void {}

/**
 * USE CASE
 *
 */
export function missingPurpose(): void {}

/**
 * ADAPTER
 *
 * Marks a declaration twice.
 */
/**
 * ADAPTER
 *
 * Marks a declaration twice.
 */
export function duplicateRole(): void {}

function outer(): void {
  /**
   * POLICY
   *
   * Cannot classify a nested declaration.
   */
  function nested(): void {}
  nested();
}

/**
 * USE CASE
 *
 * Cannot classify an anonymous declaration.
 */
export default function (): void {}

/**
 * POLICY
 *
 * This marker is separated from its declaration.
 */
/** A nearby unrelated comment. */
export function nearbyComment(): void {}

/**
 * USE CASE
 *
 * Coalesces valid overload declarations.
 */
export function overloaded(value: string): string;
/**
 * POLICY
 *
 * Conflicts on a later overload.
 */
export function overloaded(value: number): number;
export function overloaded(value: string | number): string | number { return value; }

export function ordinaryUnmarkedHelper(): void {}
`,
    });

    const result = analyzeObserverArchitecture({ rootDir: root });
    const markers = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "OBS_ARCH_MARKER",
    );
    expect(markers.length).toBeGreaterThanOrEqual(9);
    expect(markers.map((diagnostic) => diagnostic.message).join("\n")).toMatch(
      /Malformed|blank JSDoc|missing its application-purpose|multiple|top-level|first exported overload|conflicting|immediately attached/,
    );
    expect(
      result.manifest.modules
        .find((module) => module.path === "apps/observer/src/markers.ts")
        ?.exports.find((entry: { name: string }) => entry.name === "ordinaryUnmarkedHelper"),
    ).toMatchObject({ role: null, purpose: null });
  });

  it("enforces resolved integration, provider-command, protocol, and workspace-export boundaries", async () => {
    const root = await createFixture(
      {
        "integrations/harness/demo/src/index.ts": `export function concreteIntegration(): void {}`,
        "integrations/harness/demo/package.json": JSON.stringify({
          name: "@station/demo",
          type: "module",
          exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
        }),
        "packages/protocol/src/index.ts": `export function protocolValue(): void {}`,
        "packages/protocol/package.json": JSON.stringify({
          name: "@station/protocol",
          type: "module",
          exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
        }),
        "apps/observer/src/commands/action.ts": `export function commandAction(): void {}`,
        "apps/observer/src/providers/registry.ts": `import { commandAction } from "../commands/action.js"; export const providerValue = commandAction;`,
        "apps/observer/src/wrongProtocol.ts": `import { protocolValue } from "@station/protocol"; export const wrong = protocolValue;`,
        "apps/observer/src/runtime/server.ts": `import { protocolValue } from "@station/protocol"; export const allowed = protocolValue;`,
        "apps/observer/src/integration.ts": `import { concreteIntegration } from "@station/demo"; export const integration = concreteIntegration;`,
      },
      {
        paths: {
          "@station/demo": ["integrations/harness/demo/src/index.ts"],
          "@station/protocol": ["packages/protocol/src/index.ts"],
        },
      },
    );

    const result = analyzeObserverArchitecture({ rootDir: root });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "OBS_ARCH_INTEGRATION" }),
        expect.objectContaining({ code: "OBS_ARCH_PROVIDER_COMMAND" }),
        expect.objectContaining({
          code: "OBS_ARCH_PROTOCOL",
          path: "apps/observer/src/wrongProtocol.ts",
        }),
      ]),
    );
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "OBS_ARCH_PROTOCOL" &&
          diagnostic.path === "apps/observer/src/runtime/server.ts",
      ),
    ).toBe(false);
  });

  it("reports compiler inventory and invalid workspace export drift", async () => {
    const root = await createFixture(
      {
        "packages/bad/src/index.ts": `export const bad = true;`,
        "packages/bad/package.json": JSON.stringify({
          name: "@station/bad",
          type: "module",
          exports: { "./other": "./dist/other.js" },
        }),
        "apps/observer/src/listed.ts": `import { bad } from "@station/bad"; export const listed = bad;`,
        "apps/observer/src/omitted.ts": `export const omitted = true;`,
      },
      {
        paths: { "@station/bad": ["packages/bad/src/index.ts"] },
        observerConfig: {
          extends: "../../tsconfig.base.json",
          compilerOptions: { rootDir: "src", outDir: "dist" },
          files: ["src/listed.ts"],
        },
      },
    );

    const result = analyzeObserverArchitecture({ rootDir: root });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "OBS_ARCH_INVENTORY",
          path: "apps/observer/src/omitted.ts",
        }),
        expect.objectContaining({ code: "OBS_ARCH_WORKSPACE_EXPORT", targetPath: "@station/bad" }),
      ]),
    );
  });

  it("includes .mts and .cts Observer production modules in the inventory", async () => {
    const root = await createFixture(
      {
        "apps/observer/src/esm.mts": `export const esmModule = true;`,
        "apps/observer/src/common.cts": `export const commonModule = true;`,
        "apps/observer/src/ambient.d.mts": `declare const ambientEsm: boolean;`,
        "apps/observer/src/ambient.d.cts": `declare const ambientCommon: boolean;`,
      },
      {
        observerConfig: {
          extends: "../../tsconfig.base.json",
          compilerOptions: { rootDir: "src", outDir: "dist" },
          files: ["src/esm.mts", "src/common.cts", "src/ambient.d.mts", "src/ambient.d.cts"],
        },
      },
    );

    const result = analyzeObserverArchitecture({ rootDir: root });
    expect(result.diagnostics).toEqual([]);
    const modulePaths = result.manifest.modules.map((module) => module.path);
    expect(modulePaths).toEqual(
      expect.arrayContaining(["apps/observer/src/common.cts", "apps/observer/src/esm.mts"]),
    );
    expect(modulePaths).not.toEqual(
      expect.arrayContaining([
        "apps/observer/src/ambient.d.cts",
        "apps/observer/src/ambient.d.mts",
      ]),
    );
  });

  it("writes byte-identical evidence atomically and reports stale output after architecture diagnostics", async () => {
    const invalidRoot = await createFixture({
      "apps/observer/src/dynamic.ts": `const target = "./other.js"; export const load = () => import(target);`,
    });
    const invalidManifestPath = join(
      invalidRoot,
      "docs/generated/observer-architecture-manifest.json",
    );
    await mkdir(dirname(invalidManifestPath), { recursive: true });
    await writeFile(invalidManifestPath, "{}\n", "utf8");
    const invalid = checkObserverArchitecture({ rootDir: invalidRoot });
    expect(invalid.diagnostics[0]).toMatchObject({ code: "OBS_ARCH_DYNAMIC" });
    expect(invalid.diagnostics.at(-1)).toMatchObject({ code: "OBS_ARCH_STALE" });
    expect(writeObserverArchitectureManifest({ rootDir: invalidRoot }).wrote).toBe(false);
    expect(await readFile(invalidManifestPath, "utf8")).toBe("{}\n");

    const root = await createFixture(validFixtureFiles);
    const manifestPath = join(root, "docs/generated/observer-architecture-manifest.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, "{}\n", "utf8");

    const stale = checkObserverArchitecture({ rootDir: root });
    expect(stale.diagnostics.at(-1)).toMatchObject({
      code: "OBS_ARCH_STALE",
      path: "docs/generated/observer-architecture-manifest.json",
    });

    const generated = writeObserverArchitectureManifest({ rootDir: root });
    expect(generated.wrote).toBe(true);
    const firstBytes = await readFile(manifestPath, "utf8");
    const regenerated = writeObserverArchitectureManifest({ rootDir: root });
    expect(regenerated.wrote).toBe(true);
    expect(await readFile(manifestPath, "utf8")).toBe(firstBytes);
    expect(checkObserverArchitecture({ rootDir: root }).diagnostics).toEqual([]);

    const cli = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "tools/lint/check-observer-architecture.mjs"),
        "--root",
        root,
        "--format=json",
      ],
      { encoding: "utf8" },
    );
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, diagnostics: [] });
  });
});

type FixtureOptions = {
  paths?: Record<string, string[]>;
  observerConfig?: Record<string, unknown>;
};

async function createFixture(
  files: Record<string, string>,
  options: FixtureOptions = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-observer-architecture-"));
  fixtureRoots.push(root);
  const paths = {
    "@station/contracts": ["packages/contracts/src/index.ts"],
    ...options.paths,
  };
  const baseConfig = {
    compilerOptions: {
      target: "ES2023",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      exactOptionalPropertyTypes: true,
      baseUrl: ".",
      paths,
    },
  };
  const observerConfig =
    options.observerConfig ??
    ({
      extends: "../../tsconfig.base.json",
      compilerOptions: { rootDir: "src", outDir: "dist" },
      include: ["src/**/*.ts"],
    } satisfies Record<string, unknown>);
  const fixtureFiles: Record<string, string> = {
    "tsconfig.base.json": `${JSON.stringify(baseConfig, null, 2)}\n`,
    "apps/observer/tsconfig.json": `${JSON.stringify(observerConfig, null, 2)}\n`,
    "packages/contracts/package.json": `${JSON.stringify(
      {
        name: "@station/contracts",
        type: "module",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      },
      null,
      2,
    )}\n`,
    ...files,
  };
  if (fixtureFiles["packages/contracts/src/index.ts"] === undefined) {
    fixtureFiles["packages/contracts/src/index.ts"] = "export {};\n";
  }
  for (const [path, contents] of Object.entries(fixtureFiles)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents.trimStart(), "utf8");
  }
  return root;
}
