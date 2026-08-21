import type { ProviderHookHealth } from "@station/contracts";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import { readHarnessHookHealth } from "../../src/commands/harnessHookHealth";
import { ProviderRegistry } from "../../src/providers/registry";

function registry(harness: FakeHarnessProvider): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider(),
    terminal: new FakeTerminalProvider(),
    harnesses: [harness],
  });
}

describe("readHarnessHookHealth", () => {
  it("returns unsupported without invoking a mutation capability", async () => {
    const harness = new FakeHarnessProvider({ id: "codex" });
    const reconcileHooks = vi.fn();
    harness.reconcileHooks = reconcileHooks;

    await expect(
      readHarnessHookHealth({ providers: registry(harness), providerId: "codex" }),
    ).resolves.toEqual({ provider: "codex", status: "unsupported" });
    expect(reconcileHooks).not.toHaveBeenCalled();
  });

  it("passes only the neutral inspection context and returns strict evidence", async () => {
    const harness = new FakeHarnessProvider({ id: "codex" });
    const health: ProviderHookHealth = { provider: "codex", status: "healthy" };
    const hookHealth = vi.fn(async () => health);
    harness.hookHealth = hookHealth;

    await expect(
      readHarnessHookHealth({
        providers: registry(harness),
        providerId: "codex",
        stationConfigPath: "/station/config.toml",
      }),
    ).resolves.toEqual(health);
    expect(hookHealth).toHaveBeenCalledWith({ stationConfigPath: "/station/config.toml" });
  });

  it("normalizes provider failures without exposing their payload", async () => {
    const harness = new FakeHarnessProvider({ id: "codex" });
    harness.hookHealth = async () => {
      throw new Error("private /provider/path");
    };

    const result = await readHarnessHookHealth({
      providers: registry(harness),
      providerId: "codex",
    });

    expect(result).toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: { code: "HARNESS_HOOK_INSPECTION_FAILED" },
      followUp: { action: "run-doctor" },
    });
    expect(JSON.stringify(result)).not.toContain("/provider/path");
  });
});
