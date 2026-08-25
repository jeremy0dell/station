import {
  ProviderHookHealthSchema,
  ProviderHookReconciliationResultSchema,
  providerHookReconciliationSucceeded,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const error = {
  tag: "HarnessProviderError",
  code: "HOOK_FAILURE",
  message: "Hook operation failed.",
  provider: "codex",
} as const;
const followUpActions = ["enable-hooks", "run-doctor", "run-explicit-takeover", "retry"] as const;

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
    [{ provider: "codex", status: "configured-disabled" }, "enable-hooks"],
    [
      { provider: "codex", status: "ownership-conflict", ownership: "different-owner" },
      "run-explicit-takeover",
    ],
    [{ provider: "codex", status: "inspection-failed", error }, "run-doctor"],
  ] as const)("enforces the $1 follow-up for hook health", (health, expectedAction) => {
    for (const action of followUpActions) {
      expect(ProviderHookHealthSchema.safeParse({ ...health, followUp: { action } }).success).toBe(
        action === expectedAction,
      );
    }
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

  it.each([
    ["configured-disabled", "enable-hooks"],
    ["ownership-conflict", "run-explicit-takeover"],
    ["write-failed", "retry"],
    ["post-write-doctor-failed", "run-doctor"],
    ["inspection-failed", "run-doctor"],
  ] as const)("enforces the %s reconciliation follow-up", (status, expectedAction) => {
    for (const action of followUpActions) {
      expect(
        ProviderHookReconciliationResultSchema.safeParse({
          ...reconciliationFixture(status),
          followUp: { action },
        }).success,
      ).toBe(action === expectedAction);
    }
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

  it.each([
    ["configured-disabled", true],
    ["unsupported", true],
    ["healthy", true],
    ["repaired", true],
    ["ownership-conflict", false],
    ["write-failed", false],
    ["post-write-doctor-failed", false],
    ["inspection-failed", false],
  ] as const)("classifies reconciliation status %s as success=%s", (status, expected) => {
    const result = ProviderHookReconciliationResultSchema.parse(reconciliationFixture(status));
    expect(providerHookReconciliationSucceeded(result)).toBe(expected);
  });
});

function reconciliationFixture(
  status:
    | "configured-disabled"
    | "unsupported"
    | "healthy"
    | "repaired"
    | "ownership-conflict"
    | "write-failed"
    | "post-write-doctor-failed"
    | "inspection-failed",
) {
  switch (status) {
    case "configured-disabled":
      return {
        provider: "codex",
        status,
        changed: false,
        verified: false,
        followUp: { action: "enable-hooks" },
      };
    case "unsupported":
      return { provider: "codex", status, changed: false, verified: false };
    case "healthy":
      return { provider: "codex", status, changed: false, verified: true };
    case "repaired":
      return { provider: "codex", status, changed: true, verified: true };
    case "ownership-conflict":
      return {
        provider: "codex",
        status,
        changed: false,
        verified: false,
        followUp: { action: "run-explicit-takeover" },
      };
    case "write-failed":
      return {
        provider: "codex",
        status,
        changed: true,
        verified: false,
        error,
        followUp: { action: "retry" },
      };
    case "post-write-doctor-failed":
      return {
        provider: "codex",
        status,
        changed: true,
        verified: false,
        error,
        followUp: { action: "run-doctor" },
      };
    case "inspection-failed":
      return {
        provider: "codex",
        status,
        changed: false,
        verified: false,
        error,
        followUp: { action: "run-doctor" },
      };
  }
}
