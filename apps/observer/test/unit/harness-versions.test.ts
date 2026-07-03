import type { HarnessProvider } from "@station/contracts";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { harnessesFromRegistry } from "../../src/reconcile/run.js";

const now = "2026-06-19T12:00:00.000Z";

function withVersionInfo(
  provider: HarnessProvider,
  versionInfo: HarnessProvider["versionInfo"],
): HarnessProvider {
  const wrapped = Object.create(provider) as HarnessProvider;
  if (versionInfo !== undefined) {
    wrapped.versionInfo = versionInfo;
  }
  return wrapped;
}

function registryWith(...harnesses: HarnessProvider[]): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({ now, worktrees: [] }),
    terminal: new FakeTerminalProvider({ now }),
    harnesses,
  });
}

describe("harness version cache", () => {
  it("caches probe results and derives updateAvailable when both versions differ", async () => {
    const outdated = withVersionInfo(new FakeHarnessProvider({ now }), async () => ({
      installedVersion: "0.3.0",
      latestVersion: "0.4.0",
    }));
    const registry = registryWith(outdated);
    await registry.refreshHarnessVersions();

    expect(harnessesFromRegistry(registry)).toEqual([
      {
        id: outdated.id,
        label: outdated.id,
        installedVersion: "0.3.0",
        latestVersion: "0.4.0",
        updateAvailable: true,
      },
    ]);
  });

  it("omits updateAvailable when versions match or half is unknown", async () => {
    const fresh = withVersionInfo(new FakeHarnessProvider({ now }), async () => ({
      installedVersion: "1.0.0",
      latestVersion: "1.0.0",
    }));
    const registry = registryWith(fresh);
    await registry.refreshHarnessVersions();
    expect(harnessesFromRegistry(registry)[0]?.updateAvailable).toBe(false);

    const partial = withVersionInfo(new FakeHarnessProvider({ now }), async () => ({
      installedVersion: "1.0.0",
    }));
    const partialRegistry = registryWith(partial);
    await partialRegistry.refreshHarnessVersions();
    expect(harnessesFromRegistry(partialRegistry)[0]).toEqual({
      id: partial.id,
      label: partial.id,
      installedVersion: "1.0.0",
    });
  });

  it("leaves failing or capability-less providers out of the cache", async () => {
    const failing = withVersionInfo(new FakeHarnessProvider({ now }), async () => {
      throw new Error("probe exploded");
    });
    const registry = registryWith(failing);
    await registry.refreshHarnessVersions();
    expect(registry.harnessVersions.size).toBe(0);
    expect(harnessesFromRegistry(registry)).toEqual([{ id: failing.id, label: failing.id }]);

    const plain = new FakeHarnessProvider({ now });
    const plainRegistry = registryWith(plain);
    await plainRegistry.refreshHarnessVersions();
    expect(plainRegistry.harnessVersions.size).toBe(0);
  });

  it("times out a hung probe without failing the refresh", async () => {
    const hung = withVersionInfo(new FakeHarnessProvider({ now }), () => new Promise(() => {}));
    const registry = registryWith(hung);
    await registry.refreshHarnessVersions({ timeoutMs: 20 });
    expect(registry.harnessVersions.size).toBe(0);
  });
});
