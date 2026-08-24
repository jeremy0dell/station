import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertBunVersion, requiredBunVersion } from "../../scripts/bun-version.mjs";
import {
  devboxRequiresInstall,
  nodeVersionSatisfiesPolicy,
  parseNodePolicy,
} from "../../scripts/run-dev-toolchain.mjs";

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
    expect(rootPackage.scripts["station:devbox"]).toBe(
      "bun scripts/run-dev-toolchain.mjs scripts/station-devbox.mjs",
    );
  });

  it("parses and enforces only an exact Bun package-manager version", async () => {
    await expect(requiredBunVersion(root)).resolves.toBe("1.4.0");
    expect(() => assertBunVersion("1.4.0", "1.4.0")).not.toThrow();
    expect(() => assertBunVersion("1.3.14", "1.4.0")).toThrow(
      "Station requires Bun 1.4.0; found 1.3.14.",
    );
  });

  it("bootstraps the source Node policy and installs only for devbox launch commands", () => {
    const policy = parseNodePolicy(">=24.2 <25", "24");
    expect(nodeVersionSatisfiesPolicy("v24.2.0", policy)).toBe(true);
    expect(nodeVersionSatisfiesPolicy("24.19.0", policy)).toBe(true);
    expect(nodeVersionSatisfiesPolicy("24.1.9", policy)).toBe(false);
    expect(nodeVersionSatisfiesPolicy("25.0.0", policy)).toBe(false);

    expect(devboxRequiresInstall(["scripts/station-devbox.mjs", "dev"])).toBe(true);
    expect(devboxRequiresInstall(["scripts/station-devbox.mjs", "tmux", "start"])).toBe(true);
    expect(devboxRequiresInstall(["scripts/station-devbox.mjs", "status"])).toBe(false);
    expect(devboxRequiresInstall(["scripts/station-devbox.mjs", "stop"])).toBe(false);
  });

  it("declares Station's direct internal graph and required OpenTUI peer explicitly", () => {
    const stationPackage = manifest("station/package.json") as {
      dependencies: Record<string, string>;
      overrides?: Record<string, string>;
    };

    expect(
      Object.fromEntries(
        internalDependencies.map((name) => [name, stationPackage.dependencies[name]]),
      ),
    ).toEqual(Object.fromEntries(internalDependencies.map((name) => [name, "workspace:*"])));
    expect(stationPackage.dependencies["@station/observer"]).toBeUndefined();
    expect(stationPackage.dependencies["web-tree-sitter"]).toBe("0.25.10");
    expect(stationPackage.overrides).toBeUndefined();
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

  it("keeps Bun's root text lockfile on lockfile version 2", () => {
    const lockfile = read("bun.lock");
    expect(lockfile).toMatch(/^\{\n {2}"lockfileVersion": 2,/u);
  });
});
