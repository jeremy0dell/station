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
const drivingPortNames = ["SetupSessionApplication"] as const;
const policyNames = [
  "assessSetupPlan",
  "resolveHarnessSelection",
  "assessHarnessTracking",
  "selectHarnessTrackingRepairTargets",
  "deriveSetupReadiness",
  "planSetup",
  "deriveSetupResult",
  "transitionSetupSession",
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
  "SetupOperationProgress",
  "SetupInspection",
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

  it("marks the setup policies and driven ports used by the session runtime", async () => {
    const drivingPorts: string[] = [];
    const policies: string[] = [];
    const drivenPorts: string[] = [];
    let markerCount = 0;
    for (const file of await sourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      markerCount += controlledRoles.reduce(
        (count, role) => count + (source.match(new RegExp(`\\* ${role}`, "g"))?.length ?? 0),
        0,
      );
      const drivingPortPattern =
        /\/\*\*\s*\n\s*\* DRIVING PORT\s*\n\s*\*\s*\n(?:\s*\* .+\n)+?\s*\*\/\s*\nexport type (\w+)/g;
      for (const match of source.matchAll(drivingPortPattern)) {
        const name = match[1];
        if (name !== undefined) drivingPorts.push(name);
      }
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

    expect(markerCount).toBe(20);
    expect(drivingPorts.sort()).toEqual([...drivingPortNames].sort());
    expect(policies.sort()).toEqual([...policyNames].sort());
    expect(drivenPorts.sort()).toEqual([...drivenPortNames].sort());
  });

  it("keeps the guided session driver on the composition-owned application boundary", async () => {
    const source = await readFile(
      "apps/cli/src/commands/setup/session/runGuidedSetupSession.ts",
      "utf8",
    );

    expect(source).not.toMatch(/from ["'][^"']*\/(?:apply|flowUtils)\.js["']/);
    expect(source).not.toContain("createSetupOperationAdapter");
    expect(source).not.toContain("createSetupComposition");
    expect(source).toMatch(/createComposition\(\s*options,/);
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
