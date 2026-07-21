import type {
  HarnessEventObservation,
  HarnessLaunchPlan,
  HarnessStatusObservation,
  ProviderDoctorContext,
} from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  type CommonHarnessProviderOptions,
  createTerminalBoundHarnessProvider,
  harnessHookDoctorOptions,
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
      canClassifyStatus: true,
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
    classifyRun: (run): HarnessStatusObservation => ({
      provider: "test",
      runId: run.id,
      status: {
        value: "unknown",
        confidence: "low",
        reason: "n/a",
        source: "harness_process",
        updatedAt: run.observedAt,
      },
      observedAt: run.observedAt,
    }),
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
      providerId: "test",
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

  it("ingests events through the runtime boundary when a spec supplies normalize", async () => {
    const observation = { provider: "test", observedAt: now } as unknown as HarnessEventObservation;
    const provider = createTerminalBoundHarnessProvider(
      baseSpec({
        ingestEvent: {
          operation: "provider.test.ingestEvent",
          errorCode: "HARNESS_TEST_EVENT_INGEST_FAILED",
          errorMessage: "ingest failed",
          normalize: () => [observation],
        },
      }),
      {},
    );

    expect(provider.ingestEvent).toBeDefined();
    await expect(
      provider.ingestEvent?.(
        { provider: "test", event: {} },
        { projects: [], worktrees: [], terminalTargets: [] },
      ),
    ).resolves.toEqual([observation]);
  });

  it("omits optional interface methods the spec does not supply", () => {
    const provider = createTerminalBoundHarnessProvider(baseSpec(), {});
    expect("doctorChecks" in provider).toBe(false);
    expect("hooksStatus" in provider).toBe(false);
    expect("ingestEvent" in provider).toBe(false);
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
          return { stdout: "test-cli 1.2.3\n", stderr: "", exitCode: 0 };
        },
      },
    );
    await expect(provider.versionInfo?.()).resolves.toEqual({ installedVersion: "1.2.3" });
  });
});

describe("harnessHookDoctorOptions", () => {
  const incumbent = {
    installHooks: true,
    observerSocketPath: "/shared/observer.sock",
    stateDir: "/checkout/A/state",
    hookSpoolDir: "/checkout/A/state/spool/hooks",
    autoStartFromHooks: true,
  };
  const requesterRuntime = {
    ingressLauncher: "/checkout/B/bin/stn-ingress",
    observerSocketPath: "/shared/observer.sock",
    stateDir: "/checkout/B/state",
    hookSpoolDir: "/checkout/B/state/spool/hooks",
    autoStartFromHooks: false,
    stationConfigPath: "/checkout/B/config.toml",
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
    });
  });

  it("does not retain the incumbent config path when the requester omits it", () => {
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
    });
  });
});
