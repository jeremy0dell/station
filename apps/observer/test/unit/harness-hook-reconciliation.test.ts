import type { ProviderHookReconciliationResult } from "@station/contracts";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import {
  reconcileConfiguredHarnessHooksOrThrow,
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

    await expect(
      reconcileConfiguredHarnessHooksOrThrow({
        providers: registry(codex, claude),
        stationConfigPath: "/station/config.toml",
      }),
    ).resolves.toEqual([
      repaired,
      { provider: "claude", status: "unsupported", changed: false, verified: false },
    ]);
    expect(reconcileHooks).toHaveBeenCalledWith({ stationConfigPath: "/station/config.toml" });
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
