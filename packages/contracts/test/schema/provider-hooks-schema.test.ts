import {
  ProviderHookHealthSchema,
  ProviderHookReconciliationResultSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const error = {
  tag: "HarnessProviderError",
  code: "HOOK_FAILURE",
  message: "Hook operation failed.",
  provider: "codex",
} as const;

describe("provider hook contracts", () => {
  it.each([
    { provider: "codex", status: "configured-disabled", followUp: { action: "enable-hooks" } },
    { provider: "codex", status: "unsupported" },
    { provider: "codex", status: "healthy" },
    { provider: "codex", status: "needs-repair", reason: "missing" },
    { provider: "codex", status: "needs-repair", reason: "owned-drift" },
    {
      provider: "codex",
      status: "ownership-conflict",
      ownership: "different-owner",
      followUp: { action: "run-explicit-takeover" },
    },
    {
      provider: "codex",
      status: "inspection-failed",
      error,
      followUp: { action: "run-doctor" },
    },
  ])("strictly parses hook health status $status", (health) => {
    expect(ProviderHookHealthSchema.parse(health)).toEqual(health);
    expect(ProviderHookHealthSchema.safeParse({ ...health, providerData: {} }).success).toBe(false);
  });

  it.each([
    {
      provider: "codex",
      status: "configured-disabled",
      changed: false,
      verified: false,
      followUp: { action: "enable-hooks" },
    },
    { provider: "codex", status: "unsupported", changed: false, verified: false },
    { provider: "codex", status: "healthy", changed: false, verified: true },
    { provider: "codex", status: "repaired", changed: true, verified: true },
    {
      provider: "codex",
      status: "ownership-conflict",
      changed: false,
      verified: false,
      followUp: { action: "run-explicit-takeover" },
    },
    {
      provider: "codex",
      status: "write-failed",
      changed: true,
      verified: false,
      error,
      followUp: { action: "retry" },
    },
    {
      provider: "codex",
      status: "post-write-doctor-failed",
      changed: true,
      verified: false,
      error,
      followUp: { action: "run-doctor" },
    },
    {
      provider: "codex",
      status: "inspection-failed",
      changed: false,
      verified: false,
      error,
      followUp: { action: "run-doctor" },
    },
  ])("strictly parses hook reconciliation status $status", (result) => {
    expect(ProviderHookReconciliationResultSchema.parse(result)).toEqual(result);
    expect(
      ProviderHookReconciliationResultSchema.safeParse({ ...result, resolvedPaths: ["/secret"] })
        .success,
    ).toBe(false);
  });

  it("rejects contradictory verified and changed states", () => {
    expect(
      ProviderHookReconciliationResultSchema.safeParse({
        provider: "codex",
        status: "healthy",
        changed: true,
        verified: true,
      }).success,
    ).toBe(false);
  });
});
