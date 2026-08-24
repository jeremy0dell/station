import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertBunVersion, requiredBunVersion } from "../../scripts/bun-version.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const internalDependencies = [
  "@station/cli",
  "@station/client",
  "@station/config",
  "@station/contracts",
  "@station/dashboard-core",
  "@station/host",
  "@station/observability",
  "@station/protocol",
  "@station/runtime",
  "@station/terminal",
] as const;

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function manifest(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

describe("Bun workspace policy", () => {
  it("keeps one exact root package-manager and workspace policy", () => {
    const rootPackage = manifest("package.json") as {
      packageManager: string;
      engines: Record<string, string>;
      workspaces: string[];
      trustedDependencies: string[];
      overrides: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(rootPackage.packageManager).toBe("bun@1.4.0");
    expect(rootPackage.engines).toEqual({ node: ">=24.2 <25" });
    expect(rootPackage.workspaces).toEqual(["apps/*", "packages/*", "integrations/*/*", "station"]);
    expect(rootPackage.trustedDependencies).toEqual(["esbuild", "lefthook", "node-pty"]);
    expect(rootPackage.overrides).toEqual({ "@typescript/old": "npm:typescript@6.0.3" });
    expect(rootPackage.devDependencies.turbo).toBe("2.10.11");
    // Bun normalizes package-bin modes during install/link, so admission is rechecked afterward.
    expect(rootPackage.scripts["station:link"]).toBe(
      "bun run build:ensure && bun link && bun run build:ensure",
    );
  });

  it("parses and enforces only an exact Bun package-manager version", async () => {
    await expect(requiredBunVersion(root)).resolves.toBe("1.4.0");
    expect(() => assertBunVersion("1.4.0", "1.4.0")).not.toThrow();
    expect(() => assertBunVersion("1.3.14", "1.4.0")).toThrow(
      "Station requires Bun 1.4.0; found 1.3.14.",
    );
  });

  it("discovers exactly the 25 intended workspace packages", () => {
    const packagePaths = [
      ...workspacePackages("apps", 1),
      ...workspacePackages("packages", 1),
      ...workspacePackages("integrations", 2),
      "station/package.json",
    ];

    expect(packagePaths).toHaveLength(25);
    expect(new Set(packagePaths).size).toBe(25);
  });

  it("declares Station's direct internal graph and required OpenTUI peer explicitly", () => {
    const stationPackage = manifest("station/package.json") as {
      dependencies: Record<string, string>;
      overrides?: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(
      Object.fromEntries(
        internalDependencies.map((name) => [name, stationPackage.dependencies[name]]),
      ),
    ).toEqual(Object.fromEntries(internalDependencies.map((name) => [name, "workspace:*"])));
    expect(stationPackage.dependencies["@station/observer"]).toBeUndefined();
    expect(stationPackage.dependencies["web-tree-sitter"]).toBe("0.25.10");
    expect(stationPackage.overrides).toBeUndefined();
    expect(stationPackage.scripts["link:station"]).toBeUndefined();
  });

  it("keeps checkout launcher ownership at the root package", () => {
    const rootPackage = manifest("package.json") as { bin: Record<string, string> };
    const tmuxPackage = manifest("integrations/terminal/tmux/package.json") as {
      bin?: Record<string, string>;
    };

    expect(rootPackage.bin).toEqual({
      stn: "./bin/stn",
      "stn-ingress": "./bin/stn-ingress",
      "stn-tmux-popup": "./integrations/terminal/tmux/bin/stn-popup",
    });
    expect(tmuxPackage.bin).toBeUndefined();
  });

  it("keeps install and script dispatch behavior centralized in bunfig", () => {
    expect(read("bunfig.toml")).toBe(`[install]
auto = "disable"
linker = "isolated"
globalStore = false
peer = false
linkWorkspacePackages = true
saveTextLockfile = true

[run]
bun = false
shell = "system"
`);
  });

  it("keeps only Bun's root text lockfile", () => {
    const lockfile = read("bun.lock");
    expect(lockfile).toMatch(/^\{\n {2}"lockfileVersion": 2,/u);
    for (const preservedResolution of [
      '"shell-quote@1.8.4"',
      '"smol-toml@1.6.1"',
      '"@types/node@25.9.3"',
      '"ws@7.5.11"',
    ]) {
      expect(lockfile, preservedResolution).toContain(preservedResolution);
    }
    expect(lockfile).toContain('"web-tree-sitter@0.25.10"');
    expect(lockfile).toContain('"turbo@2.10.11"');
    for (const obsolete of [
      ".npmrc",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "station/bun.lock",
      "station/scripts/link-station-packages.sh",
    ]) {
      expect(existsSync(join(root, obsolete)), obsolete).toBe(false);
    }
  });
});

function workspacePackages(directory: string, depth: 1 | 2): string[] {
  const firstLevel = readdirSync(join(root, directory), { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  if (depth === 1) {
    return firstLevel.flatMap((entry) => {
      const path = `${directory}/${entry.name}/package.json`;
      return existsSync(join(root, path)) ? [path] : [];
    });
  }
  return firstLevel.flatMap((entry) =>
    readdirSync(join(root, directory, entry.name), { withFileTypes: true }).flatMap((child) => {
      const path = `${directory}/${entry.name}/${child.name}/package.json`;
      return child.isDirectory() && existsSync(join(root, path)) ? [path] : [];
    }),
  );
}
