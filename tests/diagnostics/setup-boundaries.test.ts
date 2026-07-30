import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve("packages/setup-core/src");
const nodeBuiltins = new Set(builtinModules.flatMap((module) => [module, `node:${module}`]));
const forbiddenPackage =
  /^@station\/(?:cli|config|observer|observability|claude|codex|cursor|opencode|pi|tmux|terminal|worktrunk|github-repository|scripted-harness|harness-shared|setup-messages)$|^integrations\/|^@clack\/|^react(?:\/|$)|^@opentui\//;
const controlledRoles = [
  "DRIVING PORT",
  "DRIVEN PORT",
  "ADAPTER",
  "USE CASE",
  "POLICY",
  "COMPOSITION ROOT",
] as const;
const policyNames = [
  "resolveHarnessSelection",
  "assessHarnessTracking",
  "selectHarnessTrackingRepairTargets",
  "deriveSetupReadiness",
  "planSetup",
  "deriveSetupResult",
] as const;

describe("setup core boundaries", () => {
  it("has no runtime, CLI, provider, presentation, or package dependency", async () => {
    const packageJson = JSON.parse(await readFile("packages/setup-core/package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies ?? {}).toEqual({});

    for (const file of await sourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      const displayPath = relative(process.cwd(), file);
      expect(source, displayPath).not.toMatch(/\b(?:process|Buffer|Bun|Deno)\b/);

      for (const specifier of importSpecifiers(source)) {
        expect(nodeBuiltins.has(specifier), `${displayPath}: ${specifier}`).toBe(false);
        expect(forbiddenPackage.test(specifier), `${displayPath}: ${specifier}`).toBe(false);
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        expect(target === sourceRoot || target.startsWith(`${sourceRoot}/`), displayPath).toBe(
          true,
        );
      }
    }
  });

  it("marks exactly the six public policies and no data declarations or barrels", async () => {
    const declarations: string[] = [];
    let markerCount = 0;
    for (const file of await sourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      markerCount += controlledRoles.reduce(
        (count, role) => count + (source.match(new RegExp(`\\* ${role}`, "g"))?.length ?? 0),
        0,
      );
      const policyPattern =
        /\/\*\*\s*\n\s*\* POLICY\s*\n\s*\*\s*\n(?:\s*\* .+\n)+?\s*\*\/\s*\nexport function (\w+)/g;
      for (const match of source.matchAll(policyPattern)) {
        const name = match[1];
        if (name !== undefined) declarations.push(name);
      }
    }

    expect(markerCount).toBe(6);
    expect(declarations.sort()).toEqual([...policyNames].sort());
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}
