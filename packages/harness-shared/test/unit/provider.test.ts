import type { HarnessLaunchPlan, ProviderDoctorContext } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  type CommonHarnessProviderOptions,
  createTerminalBoundHarnessProvider,
  harnessHookDoctorOptions,
  harnessHookReconciliationOptions,
  harnessHooksStatusFrom,
  type TerminalBoundHarnessProviderSpec,
} from "../../src/provider";

const now = "2026-06-19T12:00:00.000Z";

type TestOptions = CommonHarnessProviderOptions & { resume?: boolean };

function baseSpec(
  overrides: Partial<TerminalBoundHarnessProviderSpec<TestOptions>> = {},
): TerminalBoundHarnessProviderSpec<TestOptions> {
  return {
    id: "test",
    displayName: "Test",
    commandEnvVar: "STATION_TEST_BIN",
    commandFallback: "test-cli",
    baseCapabilities: {
      canLaunch: true,
      canDiscoverRuns: true,
      canEmitEvents: true,
      canReceivePrompt: false,
      canResume: false,
      canStop: false,
      canRunNonInteractive: true,
      canExposeApprovalState: false,
      supportsModifiedEnterSoftNewline: false,
    },
    resumeFromOptions: (options) => options.resume === true,
    health: {
      args: ["--version"],
      diagnostics: (result) => ({ out: result.stdout.trim() }),
      unavailableError: () => ({
        tag: "HarnessProviderError",
        code: "HARNESS_TEST_UNAVAILABLE",
        message: "Test harness is not available.",
        provider: "test",
      }),
    },
    buildLaunch: (): HarnessLaunchPlan => ({
      provider: "test",
      command: "test-cli",
      args: [],
      mode: "interactive",
    }),
    unknownStatusReason: "Test run has no reliable status signal.",
    ...overrides,
  };
}

describe("createTerminalBoundHarnessProvider", () => {
  it("resolves canResume from the per-instance resume toggle", () => {
    const spec = baseSpec();
    expect(createTerminalBoundHarnessProvider(spec, {}).capabilities().canResume).toBe(false);
    expect(
      createTerminalBoundHarnessProvider(spec, { resume: true }).capabilities().canResume,
    ).toBe(true);
  });

  it("reports healthy with command-derived diagnostics", async () => {
    const provider = createTerminalBoundHarnessProvider(baseSpec(), {
      command: "probe",
      now: () => new Date(now),
      runner: async (input) => ({
        command: input.command,
        args: input.args ?? [],
        stdout: "v1.2.3\n",
        stderr: "",
        exitCode: 0,
      }),
    });

    await expect(provider.health()).resolves.toMatchObject({
      provider: "test",
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: now,
      diagnostics: { out: "v1.2.3" },
    });
  });

  it("maps a failing health probe to the spec's unavailable error", async () => {
    const provider = createTerminalBoundHarnessProvider(baseSpec(), {
      now: () => new Date(now),
      runner: async () => {
        throw new Error("not found");
      },
    });

    await expect(provider.health()).resolves.toMatchObject({
      status: "unavailable",
      lastError: {
        tag: "HarnessProviderError",
        code: "HARNESS_TEST_UNAVAILABLE",
        provider: "test",
      },
    });
  });

  it("keeps raw hook ingestion out of the provider operation surface", () => {
    const provider = createTerminalBoundHarnessProvider(baseSpec(), {});
    expect(Object.keys(provider)).toEqual([
      "id",
      "capabilities",
      "health",
      "discoverRuns",
      "buildLaunch",
    ]);
  });

  it("omits optional interface methods the spec does not supply", () => {
    const provider = createTerminalBoundHarnessProvider(baseSpec(), {});
    expect("doctorChecks" in provider).toBe(false);
    expect("hooksStatus" in provider).toBe(false);
    expect("acceptsPersistedEvent" in provider).toBe(false);
  });

  it("attaches optional interface methods the spec supplies", () => {
    const provider = createTerminalBoundHarnessProvider(
      baseSpec({
        doctorChecks: async () => [],
        hooksStatus: async () => ({
          provider: "test",
          installed: false,
          requested: false,
          missing: [],
          message: "n/a",
        }),
        acceptsPersistedEvent: () => false,
      }),
      {},
    );
    expect("doctorChecks" in provider).toBe(true);
    expect("hooksStatus" in provider).toBe(true);
    expect(provider.acceptsPersistedEvent?.({ provider: "test", observedAt: now })).toBe(false);
  });

  it("preserves hook artifact ownership in shared status mapping", () => {
    const requested = {
      schemaVersion: 1 as const,
      launcher: "/source/bin/stn-ingress",
      runtimeKind: "source" as const,
      version: "0.0.0-pre-alpha.14.1",
      buildIdentity: "a".repeat(64),
    };

    expect(
      harnessHooksStatusFrom("codex", true, {
        installed: false,
        missing: ["station-codex-hook.sh"],
        message: "Another Station runtime owns the hook.",
        ownership: { status: "unknown-owner", requested },
      }),
    ).toMatchObject({
      provider: "codex",
      ownership: { status: "unknown-owner", requested },
    });
  });
});

describe("versionInfo", () => {
  it("stays absent when the spec declares no version block", () => {
    const provider = createTerminalBoundHarnessProvider(baseSpec(), {});
    expect(provider.versionInfo).toBeUndefined();
  });

  it("parses installed and latest version tokens from the probes", async () => {
    const provider = createTerminalBoundHarnessProvider(
      baseSpec({ version: { latestPackage: "@example/test-cli" } }),
      {
        now: () => now,
        runner: async (input) => ({
          command: input.command,
          args: input.args ?? [],
          stdout: input.command === "npm" ? "1.4.0\n" : "test-cli 1.2.3 (build abc)\n",
          stderr: "",
          exitCode: 0,
        }),
      },
    );
    await expect(provider.versionInfo?.()).resolves.toEqual({
      installedVersion: "1.2.3",
      latestVersion: "1.4.0",
    });
  });

  it("omits whatever half fails and never rejects", async () => {
    const provider = createTerminalBoundHarnessProvider(
      baseSpec({ version: { latestPackage: "@example/test-cli" } }),
      {
        now: () => now,
        runner: async (input) => {
          if (input.command === "npm") {
            throw new Error("offline");
          }
          return {
            command: input.command,
            args: input.args ?? [],
            stdout: "test-cli 1.2.3\n",
            stderr: "",
            exitCode: 0,
          };
        },
      },
    );
    await expect(provider.versionInfo?.()).resolves.toEqual({ installedVersion: "1.2.3" });
  });
});

describe("harnessHookDoctorOptions", () => {
  const incumbent = {
    installHooks: true,
    hookBin: "/checkout/A/bin/stn-ingress",
    observerSocketPath: "/shared/observer.sock",
    stateDir: "/checkout/A/state",
    hookSpoolDir: "/checkout/A/state/spool/hooks",
    autoStartFromHooks: true,
    artifactOwner: {
      schemaVersion: 1 as const,
      launcher: "/checkout/A/bin/stn-ingress",
      runtimeKind: "source" as const,
      version: "0.0.0-test",
      buildIdentity: "a".repeat(64),
    },
  };

  it("preserves the incumbent hook launcher without a requester runtime", () => {
    expect(harnessHookDoctorOptions(incumbent)).toMatchObject({
      enabled: true,
      hookBin: incumbent.hookBin,
      artifactOwner: incumbent.artifactOwner,
    });
  });
  const requesterRuntime = {
    ingressLauncher: "/checkout/B/bin/stn-ingress",
    observerSocketPath: "/shared/observer.sock",
    stateDir: "/checkout/B/state",
    hookSpoolDir: "/checkout/B/state/spool/hooks",
    autoStartFromHooks: false,
    stationConfigPath: "/checkout/B/config.toml",
    artifactOwner: {
      schemaVersion: 1 as const,
      launcher: "/checkout/B/bin/stn-ingress",
      runtimeKind: "source" as const,
      version: "0.0.0-test",
      buildIdentity: "b".repeat(64),
    },
  };

  it("uses the whole requester hook runtime instead of mixing incumbent fields", () => {
    const context: ProviderDoctorContext = {
      stationConfigPath: "/checkout/A/config.toml",
      providerHookRuntime: requesterRuntime,
    };

    expect(harnessHookDoctorOptions(incumbent, context)).toEqual({
      enabled: true,
      hookBin: requesterRuntime.ingressLauncher,
      observerSocketPath: requesterRuntime.observerSocketPath,
      stateDir: requesterRuntime.stateDir,
      hookSpoolDir: requesterRuntime.hookSpoolDir,
      autoStartFromHooks: requesterRuntime.autoStartFromHooks,
      stationConfigPath: requesterRuntime.stationConfigPath,
      artifactOwner: requesterRuntime.artifactOwner,
    });
  });

  it("drops an omitted requester config path but preserves the incumbent artifact owner", () => {
    const context: ProviderDoctorContext = {
      stationConfigPath: "/checkout/A/config.toml",
      providerHookRuntime: {
        ingressLauncher: requesterRuntime.ingressLauncher,
        observerSocketPath: requesterRuntime.observerSocketPath,
        stateDir: requesterRuntime.stateDir,
        hookSpoolDir: requesterRuntime.hookSpoolDir,
        autoStartFromHooks: requesterRuntime.autoStartFromHooks,
      },
    };

    expect(harnessHookDoctorOptions(incumbent, context)).toEqual({
      enabled: true,
      hookBin: requesterRuntime.ingressLauncher,
      observerSocketPath: requesterRuntime.observerSocketPath,
      stateDir: requesterRuntime.stateDir,
      hookSpoolDir: requesterRuntime.hookSpoolDir,
      autoStartFromHooks: requesterRuntime.autoStartFromHooks,
      artifactOwner: incumbent.artifactOwner,
    });
  });

  it("preserves cancellation, deadline, and mutation commit without mixing read authority", () => {
    const controller = new AbortController();
    const beginMutation = () => undefined;
    const context = {
      signal: controller.signal,
      timeoutMs: 125,
      beginMutation,
    };

    expect(harnessHookDoctorOptions(incumbent, context)).toMatchObject({
      signal: controller.signal,
      timeoutMs: 125,
    });
    expect(harnessHookDoctorOptions(incumbent, context)).not.toHaveProperty("beginMutation");
    expect(harnessHookReconciliationOptions(incumbent, context)).toMatchObject({
      signal: controller.signal,
      timeoutMs: 125,
      beginMutation,
    });
  });
});
