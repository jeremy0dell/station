import type { HarnessHooksStatus, ProviderHealth, ProviderId, SafeError } from "@station/contracts";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import { assertHarnessLaunchPreconditionsOrThrow } from "../../src/commands/harnessLaunchPreflight";
import { ProviderRegistry } from "../../src/providers/registry";

const now = "2026-07-28T12:00:00.000Z";

class PreflightHarness extends FakeHarnessProvider {
  healthCalls = 0;
  hooksCalls = 0;
  readonly #healthProbe: () => Promise<ProviderHealth>;
  readonly #hooksProbe: () => Promise<HarnessHooksStatus>;

  constructor(
    options: {
      health?: () => Promise<ProviderHealth>;
      hooks?: () => Promise<HarnessHooksStatus>;
      canLaunch?: boolean;
      id?: ProviderId;
    } = {},
  ) {
    super({
      id: options.id ?? "fake-harness",
      now,
      capabilities: { canLaunch: options.canLaunch ?? true },
    });
    this.#healthProbe = options.health ?? (() => super.health());
    this.#hooksProbe =
      options.hooks ??
      (async () => ({
        provider: this.id,
        requested: true,
        installed: true,
        missing: [],
        message: "Installed.",
      }));
  }

  override async health(): Promise<ProviderHealth> {
    this.healthCalls += 1;
    return this.#healthProbe();
  }

  async hooksStatus(): Promise<HarnessHooksStatus> {
    this.hooksCalls += 1;
    return this.#hooksProbe();
  }
}

function registry(harnesses: FakeHarnessProvider[]): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider(),
    terminal: new FakeTerminalProvider(),
    harnesses,
  });
}

describe("assertHarnessLaunchPreconditionsOrThrow", () => {
  it("refreshes only the selected provider and then verifies its hooks", async () => {
    const selected = new PreflightHarness();
    const other = new PreflightHarness({ id: "other-harness" });
    const providers = registry([selected, other]);

    await assertHarnessLaunchPreconditionsOrThrow({
      providers,
      providerId: selected.id,
    });

    expect(selected.healthCalls).toBe(1);
    expect(selected.hooksCalls).toBe(1);
    expect(other.healthCalls).toBe(0);
    expect(other.hooksCalls).toBe(0);
  });

  it("repairs the selected provider before verifying installed hook delivery", async () => {
    let repaired = false;
    const harness = new PreflightHarness({
      hooks: async () => ({
        provider: "fake-harness",
        requested: true,
        installed: repaired,
        missing: repaired ? [] : ["hook"],
        message: repaired ? "Installed." : "Missing.",
      }),
    });
    const controller = new AbortController();
    const beginMutation = vi.fn();
    harness.reconcileHooks = async (context) => {
      expect(context).toMatchObject({ signal: controller.signal, beginMutation });
      context?.beginMutation?.();
      repaired = true;
      return {
        provider: harness.id,
        status: "repaired",
        changed: true,
        verified: true,
      };
    };

    await assertHarnessLaunchPreconditionsOrThrow({
      providers: registry([harness]),
      providerId: harness.id,
      signal: controller.signal,
      beginMutation,
    });

    expect(repaired).toBe(true);
    expect(beginMutation).toHaveBeenCalledOnce();
    expect(harness.hooksCalls).toBe(1);
  });

  it("fails before the legacy hook gate when automatic reconciliation is unverified", async () => {
    const harness = new PreflightHarness();
    harness.reconcileHooks = async () => ({
      provider: harness.id,
      status: "ownership-conflict",
      changed: false,
      verified: false,
      followUp: { action: "run-explicit-takeover" },
    });

    await expect(
      assertHarnessLaunchPreconditionsOrThrow({
        providers: registry([harness]),
        providerId: harness.id,
      }),
    ).rejects.toMatchObject({ code: "HARNESS_HOOK_OWNERSHIP_CONFLICT" });
    expect(harness.hooksCalls).toBe(0);
  });

  it("rejects unavailable capabilities and unregistered providers before probing", async () => {
    const disabled = new PreflightHarness({ canLaunch: false });
    const providers = registry([disabled]);

    await expect(
      assertHarnessLaunchPreconditionsOrThrow({ providers, providerId: disabled.id }),
    ).rejects.toMatchObject({ code: "HARNESS_PROVIDER_UNAVAILABLE", provider: disabled.id });
    expect(disabled.healthCalls).toBe(0);
    expect(disabled.hooksCalls).toBe(0);

    await expect(
      assertHarnessLaunchPreconditionsOrThrow({ providers, providerId: "missing-harness" }),
    ).rejects.toMatchObject({ code: "HARNESS_PROVIDER_UNAVAILABLE", provider: "missing-harness" });
  });

  it("preserves an unavailable health error and skips hook inspection", async () => {
    const healthError: SafeError = {
      tag: "ProviderUnavailableError",
      code: "FAKE_CLI_MISSING",
      message: "The fake CLI is unavailable.",
      provider: "fake-harness",
    };
    const harness = new PreflightHarness({
      health: async () => ({
        provider: "fake-harness",
        providerType: "harness",
        status: "unavailable",
        lastCheckedAt: now,
        lastError: healthError,
        capabilities: { canLaunch: true },
      }),
    });

    await expect(
      assertHarnessLaunchPreconditionsOrThrow({
        providers: registry([harness]),
        providerId: harness.id,
      }),
    ).rejects.toEqual(healthError);
    expect(harness.hooksCalls).toBe(0);
  });

  it.each([
    "degraded",
    "unknown",
  ] as const)("allows %s health and providers without hook inspection", async (status) => {
    const harness = new FakeHarnessProvider({
      now,
      health: { status },
    });

    await expect(
      assertHarnessLaunchPreconditionsOrThrow({
        providers: registry([harness]),
        providerId: harness.id,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    [true, "not installed"],
    [false, "not enabled"],
  ] as const)("preserves config-aware hook guidance when hooks are %s", async (requested, phrase) => {
    const harness = new PreflightHarness({
      hooks: async () => ({
        provider: "fake-harness",
        requested,
        installed: false,
        missing: ["SessionStart"],
        message: "Missing.",
      }),
    });

    await expect(
      assertHarnessLaunchPreconditionsOrThrow({
        providers: registry([harness]),
        providerId: harness.id,
        stationConfigPath: "/tmp/custom station/config.toml",
      }),
    ).rejects.toMatchObject({
      code: "HARNESS_HOOKS_NOT_INSTALLED",
      message: expect.stringContaining(phrase),
      hint: expect.stringContaining("/tmp/custom station/config.toml"),
    });
  });

  it("preserves hook inspection failures", async () => {
    const harness = new PreflightHarness({
      hooks: async () => {
        throw new Error("hook status failed");
      },
    });

    await expect(
      assertHarnessLaunchPreconditionsOrThrow({
        providers: registry([harness]),
        providerId: harness.id,
      }),
    ).rejects.toMatchObject({
      code: "HARNESS_HOOKS_STATUS_FAILED",
      provider: harness.id,
    });
  });

  it("shares one health flight across concurrent preflights", async () => {
    let release: (health: ProviderHealth) => void = () => undefined;
    const harness = new PreflightHarness({
      health: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const providers = registry([harness]);

    const first = assertHarnessLaunchPreconditionsOrThrow({ providers, providerId: harness.id });
    const second = assertHarnessLaunchPreconditionsOrThrow({ providers, providerId: harness.id });
    await vi.waitFor(() => expect(harness.healthCalls).toBe(1));
    release({
      provider: harness.id,
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: now,
      capabilities: { canLaunch: true },
    });
    await Promise.all([first, second]);

    expect(harness.healthCalls).toBe(1);
    expect(harness.hooksCalls).toBe(2);
  });

  it("observes cancellation after a shared health flight without cancelling it", async () => {
    let release: (health: ProviderHealth) => void = () => undefined;
    const harness = new PreflightHarness({
      health: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const controller = new AbortController();
    const preflight = assertHarnessLaunchPreconditionsOrThrow({
      providers: registry([harness]),
      providerId: harness.id,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(harness.healthCalls).toBe(1));
    controller.abort({
      tag: "CancellationError",
      code: "COMMAND_CANCELLED",
      message: "Observer command was cancelled.",
    });
    release({
      provider: harness.id,
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: now,
      capabilities: { canLaunch: true },
    });

    await expect(preflight).rejects.toMatchObject({ code: "COMMAND_CANCELLED" });
    expect(harness.hooksCalls).toBe(0);
  });
});
