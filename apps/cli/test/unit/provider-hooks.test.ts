import {
  ProviderHookReconciliationResultSchema,
  providerHookReconciliationSucceeded,
} from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createProviderHooksRunner } from "../../src/commands/providerHooks.js";

describe("standalone provider-hook reconciliation", () => {
  it.each([
    [
      "private payload",
      async () => ({
        provider: "codex",
        status: "healthy",
        changed: false,
        verified: true,
        privatePayload: { token: "provider-secret" },
      }),
    ],
    [
      "wrong provider",
      async () => ({ provider: "claude", status: "healthy", changed: false, verified: true }),
    ],
    [
      "provider throw",
      async () => {
        throw new Error("private provider failure");
      },
    ],
  ])("returns neutral nonzero evidence for %s", async (_name, reconcile) => {
    const adapter = {
      provider: "codex" as const,
      plan: async () => ({}),
      install: async () => ({}),
      uninstall: async () => ({}),
      doctor: async () => ({}),
      reconcile: async () => ({
        provider: "codex" as const,
        status: "healthy" as const,
        changed: false as const,
        verified: true as const,
      }),
      buildOptions: () => ({}),
      isEnabled: () => true,
    };
    Reflect.set(adapter, "reconcile", reconcile);
    const runner = createProviderHooksRunner(adapter, {
      providerConfigFlag: "--codex-config",
      supportsHookScript: true,
      supportsHookBin: true,
    });

    const result = ProviderHookReconciliationResultSchema.parse(await runner(["reconcile"]));
    expect(result).toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: { provider: "codex" },
      followUp: { action: "run-doctor" },
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(providerHookReconciliationSucceeded(result)).toBe(false);
  });
});
