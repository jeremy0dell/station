import type { ProviderHookReconciliationResult } from "@station/contracts";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import {
  reconcileConfiguredHarnessHooksOrThrow,
  reconcileHarnessHooks,
  reconcileHarnessHooksOrThrow,
} from "../../src/commands/harnessHookReconciliation";
import { ProviderRegistry } from "../../src/providers/registry";

function registry(...harnesses: FakeHarnessProvider[]): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider(),
    terminal: new FakeTerminalProvider(),
    harnesses,
  });
}

describe("harness hook reconciliation", () => {
  it("returns provider-neutral failure evidence without throwing", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    codex.reconcileHooks = async () => {
      throw new Error("private provider failure");
    };

    await expect(
      reconcileHarnessHooks({ providers: registry(codex), providerId: "codex" }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      changed: false,
      verified: false,
      error: { code: "HARNESS_HOOK_RECONCILIATION_FAILED", provider: "codex" },
    });
  });

  it("returns neutral failure evidence when the configured provider is unavailable", async () => {
    await expect(
      reconcileHarnessHooks({ providers: registry(), providerId: "codex" }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      changed: false,
      verified: false,
      error: { code: "HARNESS_PROVIDER_UNAVAILABLE", provider: "codex" },
    });
  });

  it.each([
    [
      "same-provider conditional fields",
      { provider: "codex", status: "healthy", changed: true, verified: true },
    ],
    [
      "private adapter keys",
      {
        provider: "codex",
        status: "healthy",
        changed: false,
        verified: true,
        privatePayload: { token: "provider-secret" },
      },
    ],
  ])("fails closed on malformed %s", async (_name, untrustedResult) => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    Reflect.set(codex, "reconcileHooks", async () => untrustedResult);

    const result = await reconcileHarnessHooks({
      providers: registry(codex),
      providerId: "codex",
    });

    expect(result).toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: { code: "HARNESS_HOOK_RECONCILIATION_INVALID_RESULT" },
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("fails closed when an adapter returns another provider's evidence", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    codex.reconcileHooks = async () => ({
      provider: "claude",
      status: "healthy",
      changed: false,
      verified: true,
    });

    await expect(
      reconcileHarnessHooks({ providers: registry(codex), providerId: "codex" }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: { code: "HARNESS_HOOK_RECONCILIATION_INVALID_RESULT" },
    });
  });

  it("rejects a mismatched registry value before invoking it", async () => {
    const claude = new FakeHarnessProvider({ id: "claude" });
    const reconcileHooks = vi.fn(async () => ({
      provider: "claude" as const,
      status: "healthy" as const,
      changed: false as const,
      verified: true as const,
    }));
    claude.reconcileHooks = reconcileHooks;
    const providers = registry();
    providers.harnesses.set("codex", claude);

    await expect(reconcileHarnessHooks({ providers, providerId: "codex" })).resolves.toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: { code: "HARNESS_HOOK_RECONCILIATION_INVALID_RESULT" },
    });
    expect(reconcileHooks).not.toHaveBeenCalled();
  });

  it("rejects provider attribution hidden in nested error evidence", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    codex.reconcileHooks = async () => ({
      provider: "codex",
      status: "inspection-failed",
      changed: false,
      verified: false,
      error: {
        tag: "HarnessProviderError",
        code: "HOOK_INSPECTION_FAILED",
        message: "Hook inspection failed.",
        provider: "claude",
      },
      followUp: { action: "run-doctor" },
    });

    await expect(
      reconcileHarnessHooks({ providers: registry(codex), providerId: "codex" }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: { code: "HARNESS_HOOK_RECONCILIATION_INVALID_RESULT", provider: "codex" },
    });
  });

  it.each([
    {
      provider: "codex",
      status: "configured-disabled",
      changed: false,
      verified: false,
      followUp: { action: "retry" },
    },
    {
      provider: "codex",
      status: "ownership-conflict",
      changed: false,
      verified: false,
      followUp: { action: "run-doctor" },
    },
    {
      provider: "codex",
      status: "write-failed",
      changed: false,
      verified: false,
      error: { tag: "HarnessProviderError", code: "WRITE_FAILED", message: "Write failed." },
      followUp: { action: "run-doctor" },
    },
    {
      provider: "codex",
      status: "inspection-failed",
      changed: false,
      verified: false,
      error: { tag: "HarnessProviderError", code: "INSPECTION_FAILED", message: "Failed." },
      followUp: { action: "retry" },
    },
    {
      provider: "codex",
      status: "post-write-doctor-failed",
      changed: true,
      verified: false,
      error: { tag: "HarnessProviderError", code: "DOCTOR_FAILED", message: "Failed." },
      followUp: { action: "retry" },
    },
  ])("rejects contradictory follow-up semantics for $status", async (untrustedResult) => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    Reflect.set(codex, "reconcileHooks", async () => untrustedResult);
    await expect(
      reconcileHarnessHooks({ providers: registry(codex), providerId: "codex" }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: { code: "HARNESS_HOOK_RECONCILIATION_INVALID_RESULT" },
    });
  });

  it("returns unsupported without inventing a mutation path", async () => {
    const harness = new FakeHarnessProvider({ id: "pi" });
    await expect(
      reconcileHarnessHooksOrThrow({ providers: registry(harness), providerId: harness.id }),
    ).resolves.toEqual({
      provider: "pi",
      status: "unsupported",
      changed: false,
      verified: false,
    });
  });

  it("reconciles every composed capability with the neutral context", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    const claude = new FakeHarnessProvider({ id: "claude" });
    const repaired: ProviderHookReconciliationResult = {
      provider: "codex",
      status: "repaired",
      changed: true,
      verified: true,
    };
    const reconcileHooks = vi.fn(async () => repaired);
    codex.reconcileHooks = reconcileHooks;

    const controller = new AbortController();
    await expect(
      reconcileConfiguredHarnessHooksOrThrow({
        providers: registry(codex, claude),
        stationConfigPath: "/station/config.toml",
        signal: controller.signal,
        timeoutMs: 250,
      }),
    ).resolves.toEqual([
      repaired,
      { provider: "claude", status: "unsupported", changed: false, verified: false },
    ]);
    expect(reconcileHooks).toHaveBeenCalledWith({
      stationConfigPath: "/station/config.toml",
      signal: controller.signal,
      timeoutMs: expect.any(Number),
    });
    const context = reconcileHooks.mock.calls[0]?.[0];
    expect(context?.timeoutMs).toBeGreaterThan(0);
    expect(context?.timeoutMs).toBeLessThanOrEqual(250);
  });

  it("shrinks one absolute startup budget across providers", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    const claude = new FakeHarnessProvider({ id: "claude" });
    let now = 1_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    const observedTimeouts: number[] = [];
    codex.reconcileHooks = async (context) => {
      observedTimeouts.push(context?.timeoutMs ?? -1);
      now += 40;
      return { provider: "codex", status: "healthy", changed: false, verified: true };
    };
    claude.reconcileHooks = async (context) => {
      observedTimeouts.push(context?.timeoutMs ?? -1);
      return { provider: "claude", status: "healthy", changed: false, verified: true };
    };

    try {
      await expect(
        reconcileConfiguredHarnessHooksOrThrow({
          providers: registry(codex, claude),
          timeoutMs: 100,
        }),
      ).resolves.toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
    expect(observedTimeouts).toEqual([100, 60]);
  });

  it("returns provider deadline failures as neutral evidence until throw policy is requested", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    const timeout = Object.assign(new Error("provider deadline"), {
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_RECONCILIATION_TIMEOUT",
      provider: "codex" as const,
    });
    codex.reconcileHooks = async () => {
      throw timeout;
    };

    await expect(
      reconcileHarnessHooks({ providers: registry(codex), providerId: "codex" }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: { code: "CODEX_HOOK_RECONCILIATION_TIMEOUT" },
    });
    await expect(
      reconcileHarnessHooksOrThrow({ providers: registry(codex), providerId: "codex" }),
    ).rejects.toMatchObject({ code: "CODEX_HOOK_RECONCILIATION_TIMEOUT" });
  });

  it("returns caller cancellation as neutral evidence without beginning mutation", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    const controller = new AbortController();
    const beginMutation = vi.fn();
    controller.abort(new Error("private cancellation reason"));
    codex.reconcileHooks = async (context) => {
      expect(context?.signal).toBe(controller.signal);
      throw context?.signal?.reason;
    };

    const result = await reconcileHarnessHooks({
      providers: registry(codex),
      providerId: "codex",
      signal: controller.signal,
      beginMutation,
    });

    expect(result).toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: { code: "HARNESS_HOOK_RECONCILIATION_FAILED" },
    });
    expect(JSON.stringify(result)).not.toContain("private cancellation reason");
    expect(beginMutation).not.toHaveBeenCalled();
  });

  it("normalizes the caught provider failure when cancellation arrives late", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    const controller = new AbortController();
    codex.reconcileHooks = async () => {
      controller.abort(
        Object.assign(new Error("late cancellation"), {
          tag: "AbortError",
          code: "HOOK_RECONCILIATION_CANCELLED",
        }),
      );
      throw Object.assign(new Error("provider failed first"), {
        tag: "CodexHookSetupError",
        code: "CODEX_HOOK_INSPECTION_FAILED",
        provider: "claude" as const,
      });
    };

    await expect(
      reconcileHarnessHooks({
        providers: registry(codex),
        providerId: "codex",
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: { code: "CODEX_HOOK_INSPECTION_FAILED", provider: "codex" },
    });
  });

  it("passes command cancellation and durable mutation authority to the provider writer", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    const controller = new AbortController();
    const beginMutation = vi.fn();
    codex.reconcileHooks = async (context) => {
      expect(context).toMatchObject({ signal: controller.signal, beginMutation });
      context?.beginMutation?.();
      return {
        provider: "codex",
        status: "repaired",
        changed: true,
        verified: true,
      };
    };

    await expect(
      reconcileHarnessHooksOrThrow({
        providers: registry(codex),
        providerId: "codex",
        signal: controller.signal,
        beginMutation,
      }),
    ).resolves.toMatchObject({ status: "repaired" });
    expect(beginMutation).toHaveBeenCalledOnce();
  });

  it("fails closed with the fixed takeover path and no provider-native evidence", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    codex.reconcileHooks = async () => ({
      provider: "codex",
      status: "ownership-conflict",
      changed: false,
      verified: false,
      followUp: { action: "run-explicit-takeover" },
    });

    await expect(
      reconcileHarnessHooksOrThrow({ providers: registry(codex), providerId: "codex" }),
    ).rejects.toEqual({
      tag: "HarnessProviderError",
      code: "HARNESS_HOOK_OWNERSHIP_CONFLICT",
      message: "Configured harness hooks are owned by another runtime.",
      provider: "codex",
      hint: "Use the explicit codex provider hook install takeover flow only to transfer ownership, then retry.",
    });
  });

  it("preserves provider SafeError while adding bounded remediation", async () => {
    const codex = new FakeHarnessProvider({ id: "codex" });
    codex.reconcileHooks = async () => ({
      provider: "codex",
      status: "write-failed",
      changed: false,
      verified: false,
      error: {
        tag: "CodexHookSetupError",
        code: "CODEX_HOOK_WRITE_FAILED",
        message: "Codex hook writes failed.",
        provider: "codex",
      },
      followUp: { action: "retry" },
    });

    await expect(
      reconcileHarnessHooksOrThrow({ providers: registry(codex), providerId: "codex" }),
    ).rejects.toMatchObject({
      code: "CODEX_HOOK_WRITE_FAILED",
      hint: "Retry codex hook reconciliation after correcting the write failure.",
    });
  });
});
