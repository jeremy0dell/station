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
const drivenPortNames = [
  "SetupConfigMutationPort",
  "SetupObserverActivationPort",
  "SetupHarnessTrackingPort",
  "SetupWorktrunkIntegrationPort",
  "SetupTmuxConfigurationPort",
  "SetupPackageInstallationPort",
  "SetupLauncherLinkPort",
  "SetupOperationExecutor",
] as const;

describe("setup core boundaries", () => {
  it("has no runtime, CLI, provider, or presentation dependency", async () => {
    const packageJson = JSON.parse(await readFile("packages/setup-core/package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies ?? {}).toEqual({
      "@station/contracts": "workspace:*",
    });

    for (const file of await sourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      const displayPath = relative(process.cwd(), file);
      expect(source, displayPath).not.toMatch(/\b(?:process|Buffer|Bun|Deno)\b/);

      for (const specifier of importSpecifiers(source)) {
        expect(nodeBuiltins.has(specifier), `${displayPath}: ${specifier}`).toBe(false);
        expect(forbiddenPackage.test(specifier), `${displayPath}: ${specifier}`).toBe(false);
        if (specifier === "@station/contracts") {
          expect(source, `${displayPath}: contracts imports must be type-only`).toMatch(
            /import\s+type\s+\{[^}]*\}\s+from\s+["']@station\/contracts["']/s,
          );
          continue;
        }
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        expect(target === sourceRoot || target.startsWith(`${sourceRoot}/`), displayPath).toBe(
          true,
        );
      }
    }
  });

  it("marks exactly the six policies and eight driven ports", async () => {
    const policies: string[] = [];
    const drivenPorts: string[] = [];
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
        if (name !== undefined) policies.push(name);
      }
      const portPattern =
        /\/\*\*\s*\n\s*\* DRIVEN PORT\s*\n\s*\*\s*\n(?:\s*\* .+\n)+?\s*\*\/\s*\nexport type (\w+)/g;
      for (const match of source.matchAll(portPattern)) {
        const name = match[1];
        if (name !== undefined) drivenPorts.push(name);
      }
    }

    expect(markerCount).toBe(14);
    expect(policies.sort()).toEqual([...policyNames].sort());
    expect(drivenPorts.sort()).toEqual([...drivenPortNames].sort());
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
