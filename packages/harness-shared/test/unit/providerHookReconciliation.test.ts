import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderHookArtifactOwner } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { reconcileDeclarativeProviderHooks } from "../../src/providerHookReconciliation";

const artifactOwner: ProviderHookArtifactOwner = {
  schemaVersion: 1,
  launcher: "/station/bin/stn-ingress",
  runtimeKind: "compiled",
  version: "0.0.0-test",
  buildIdentity: "a".repeat(64),
};

const errors = {
  tag: "TestHookSetupError",
  inspection: { code: "TEST_INSPECTION_FAILED", message: "Test inspection failed." },
  write: { code: "TEST_WRITE_FAILED", message: "Test write failed." },
  verification: { code: "TEST_VERIFICATION_FAILED", message: "Test verification failed." },
} as const;

describe("declarative provider hook reconciliation", () => {
  it("repairs owned artifacts, verifies them, and begins one durable mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-provider-hook-reconciliation-"));
    let installed = false;
    const beginMutation = vi.fn();

    await expect(
      reconcileDeclarativeProviderHooks({
        provider: "claude",
        enabled: true,
        artifactOwner,
        artifactPaths: [join(root, "hook.sh")],
        beginMutation,
        inspect: async () =>
          installed
            ? {
                status: "ok",
                installed: true,
                ownership: {
                  status: "same-owner",
                  requested: artifactOwner,
                  currentLauncher: artifactOwner.launcher,
                },
              }
            : {
                status: "warn",
                installed: false,
                ownership: {
                  status: "same-owner",
                  requested: artifactOwner,
                  currentLauncher: artifactOwner.launcher,
                },
              },
        install: async ({ beginMutation: begin, onMutationCommitted }) => {
          begin();
          begin();
          installed = true;
          onMutationCommitted();
          return { changed: true };
        },
        errors,
      }),
    ).resolves.toEqual({
      provider: "claude",
      status: "repaired",
      changed: true,
      verified: true,
    });
    expect(beginMutation).toHaveBeenCalledTimes(1);
  });

  it("refuses automatic takeover before calling the writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-provider-hook-conflict-"));
    const install = vi.fn(async () => ({ changed: true }));
    const current = { ...artifactOwner, launcher: "/other/bin/stn-ingress" };

    await expect(
      reconcileDeclarativeProviderHooks({
        provider: "opencode",
        enabled: true,
        artifactOwner,
        artifactPaths: [join(root, "plugin.js")],
        inspect: async () => ({
          status: "warn",
          installed: false,
          ownership: {
            status: "different-owner",
            requested: artifactOwner,
            currentLauncher: current.launcher,
            current,
          },
        }),
        install,
        errors,
      }),
    ).resolves.toEqual({
      provider: "opencode",
      status: "ownership-conflict",
      changed: false,
      verified: false,
      followUp: { action: "run-explicit-takeover" },
    });
    expect(install).not.toHaveBeenCalled();
  });
});
