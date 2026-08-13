import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve("packages/setup-core/src");
const cliSetupRoot = resolve("apps/cli/src/commands/setup");
const nodeBuiltins = new Set(builtinModules.flatMap((module) => [module, `node:${module}`]));
const forbiddenPackage =
  /^@station\/(?:cli|config|observer|observability|claude|codex|cursor|opencode|pi|tmux|terminal|worktrunk|github-repository|scripted-harness|harness-shared|setup-messages)$|^integrations\/|^@clack\/|^react(?:\/|$)|^@opentui\//;
const retiredSetupModules = [
  "apply.ts",
  "configWriter.ts",
  "flowUtils.ts",
  "harnessInstall.ts",
  "harnessSelection.ts",
  "model.ts",
  "planner.ts",
  "presentation/projectCliSetupPlan.ts",
  "render.ts",
  "theme.ts",
] as const;
const retiredSetupCoreModules = [
  "session/checkpoints.ts",
  "session/transition.ts",
  "session/transitionApplying.ts",
  "session/transitionBlocked.ts",
  "session/transitionEditing.ts",
  "session/transitionInspecting.ts",
  "session/transitionReviewing.ts",
  "session/transitionVerifying.ts",
] as const;
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

    expect(markerCount).toBe(17);
    expect(drivingPorts.sort()).toEqual([...drivingPortNames].sort());
    expect(policies.sort()).toEqual([...policyNames].sort());
    expect(drivenPorts.sort()).toEqual([...drivenPortNames].sort());
  });

  it("has no second event, effect, transition, or checkpoint orchestration layer", async () => {
    for (const retiredModule of retiredSetupCoreModules) {
      await expect(readFile(resolve(sourceRoot, retiredModule), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    const source = (
      await Promise.all((await sourceFiles(sourceRoot)).map((file) => readFile(file, "utf8")))
    ).join("\n");
    expect(source).not.toMatch(
      /\b(?:SetupSessionEvent|SetupSessionEffect|SetupSessionTransition|transitionSetupSession|recordCompletedSetupOperation)\b/,
    );
  });

  it("removes compatibility orchestration and all production imports of it", async () => {
    for (const retiredModule of retiredSetupModules) {
      await expect(readFile(resolve(cliSetupRoot, retiredModule), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    const retiredPaths = new Set(
      retiredSetupModules.map((retiredModule) => resolve(cliSetupRoot, retiredModule)),
    );
    for (const file of await sourceFiles(cliSetupRoot)) {
      const source = await readFile(file, "utf8");
      const importedRetiredPaths = importSpecifiers(source)
        .filter((specifier) => specifier.startsWith("."))
        .map((specifier) => resolve(dirname(file), specifier.replace(/\.js$/, ".ts")))
        .filter((importedPath) => retiredPaths.has(importedPath));
      const displayPath = relative(process.cwd(), file);
      expect(importedRetiredPaths, displayPath).toEqual([]);
      expect(source, displayPath).not.toMatch(
        /\b(?:applySetupPlan|SetupOperationBinding|isHarnessInstallAction)\b/,
      );
    }
  });

  it("routes setup entrypoints through semantic composition and operation adapters", async () => {
    for (const flow of ["guided.ts", "readOnly.ts", "nonInteractive.ts"] as const) {
      const source = await readFile(resolve(cliSetupRoot, "flows", flow), "utf8");
      expect(source, flow).toContain("createSetupComposition");
    }

    const system = await readFile(resolve(cliSetupRoot, "systemCommand.ts"), "utf8");
    expect(system).toContain("SetupToolInstallOperation");
    expect(system).toContain("createSetupOperationAdapter");
    expect(system).not.toContain("SetupAction");
    expect(system).not.toContain("SetupPlan");
    expect(system).not.toContain("applySetupPlan");
  });

  it("confines Clack to the guided terminal adapter", async () => {
    const importers: string[] = [];
    for (const file of await sourceFiles(cliSetupRoot)) {
      const source = await readFile(file, "utf8");
      if (importSpecifiers(source).includes("@clack/prompts")) {
        importers.push(relative(process.cwd(), file));
      }
    }

    expect(importers).toEqual(["apps/cli/src/commands/setup/presenters/clack.ts"]);
    const adapter = await readFile("apps/cli/src/commands/setup/presenters/clack.ts", "utf8");
    expect(adapter).not.toMatch(
      /from ["']@station\/(?:claude|codex|cursor|opencode|pi|worktrunk)["']/,
    );
  });

  it("keeps the guided session driver on the composition-owned application boundary", async () => {
    const source = await readFile(
      "apps/cli/src/commands/setup/session/runGuidedSetupSession.ts",
      "utf8",
    );

    expect(source).not.toMatch(/from ["'][^"']*\/(?:apply|flowUtils)\.js["']/);
    expect(source).not.toContain("@clack/prompts");
    expect(source).not.toContain("createSetupOperationAdapter");
    expect(source).not.toContain("createSetupComposition");
    expect(source).not.toContain("applySetupPlan");
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
