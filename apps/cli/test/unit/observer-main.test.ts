import type { StationConfig } from "@station/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runObserverMain: vi.fn(),
  createProviderRegistry: vi.fn(),
}));

vi.mock("@station/observer", () => ({ runObserverMain: mocks.runObserverMain }));
vi.mock("../../src/observerProviders.js", () => ({
  createProviderRegistry: mocks.createProviderRegistry,
}));

import { runCliObserverMain, runCliObserverProcess } from "../../src/observerMain.js";

const ingressLauncher = "/source/bin/stn-ingress";
const artifactOwner = {
  schemaVersion: 1 as const,
  launcher: ingressLauncher,
  runtimeKind: "source" as const,
  version: "0.0.0-test",
  buildIdentity: "a".repeat(64),
};

describe("runCliObserverMain", () => {
  beforeEach(() => {
    mocks.runObserverMain.mockReset();
    mocks.createProviderRegistry.mockReset();
    mocks.runObserverMain.mockResolvedValue(0);
  });

  it("prepares Pi from the canonical Observer state directory", async () => {
    const preparePiExtension = vi.fn(
      async (stateDir: string) => `${stateDir}/assets/pi/station-pi-extension.mjs`,
    );

    await expect(
      runCliObserverMain(["--state-dir", "/custom/state"], {
        preparePiExtension,
        providerHookIngressLauncher: ingressLauncher,
        providerHookArtifactOwner: artifactOwner,
      }),
    ).resolves.toBe(0);

    const deps = mocks.runObserverMain.mock.calls[0]?.[1] as {
      providerRegistryFactory: (
        config: StationConfig,
        options: { stateDir: string; configPath?: string },
      ) => Promise<unknown>;
    };
    const config = {} as StationConfig;
    await deps.providerRegistryFactory(config, {
      stateDir: "/canonical/state",
      configPath: "/config/station.toml",
    });

    expect(preparePiExtension).toHaveBeenCalledWith("/canonical/state");
    expect(mocks.createProviderRegistry).toHaveBeenCalledWith(config, {
      configPath: "/config/station.toml",
      piExtensionPath: "/canonical/state/assets/pi/station-pi-extension.mjs",
      providerHookIngressLauncher: ingressLauncher,
      providerHookArtifactOwner: artifactOwner,
    });
  });

  it("does not prepare or inject Pi assets in source composition", async () => {
    await runCliObserverMain([], {
      providerHookIngressLauncher: ingressLauncher,
      providerHookArtifactOwner: artifactOwner,
    });

    const deps = mocks.runObserverMain.mock.calls[0]?.[1] as {
      providerRegistryFactory: (
        config: StationConfig,
        options: { stateDir: string },
      ) => Promise<unknown>;
    };
    const config = {} as StationConfig;
    await deps.providerRegistryFactory(config, { stateDir: "/source/state" });

    expect(mocks.createProviderRegistry).toHaveBeenCalledWith(config, {
      providerHookIngressLauncher: ingressLauncher,
      providerHookArtifactOwner: artifactOwner,
    });
  });

  it("reports source-process failures with redacted stderr and exit status", async () => {
    mocks.runObserverMain.mockRejectedValue(
      new Error("startup failed with API_TOKEN=super-secret-value\n    at private-frame"),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        runCliObserverProcess((startupReadinessSink) =>
          runCliObserverMain([], {
            providerHookIngressLauncher: ingressLauncher,
            providerHookArtifactOwner: artifactOwner,
            startupReadinessSink,
          }),
        ),
      ).resolves.toBe(1);
      expect(stderr).toHaveBeenCalledWith(
        "startup failed with API_TOKEN=[REDACTED] (OBSERVER_STARTUP_CAUSE_ERROR)\n",
      );
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("private-frame"));
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("super-secret-value"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("closes the common process reporter after a successful run", async () => {
    const startupFailureReporter = {
      ready: vi.fn(),
      failure: vi.fn(),
    };

    await expect(
      runCliObserverProcess(
        async (startupReadinessSink) => {
          startupReadinessSink.ready();
          return 0;
        },
        {
          startupFailureReporter,
        },
      ),
    ).resolves.toBe(0);

    expect(startupFailureReporter.ready).toHaveBeenCalledOnce();
    expect(startupFailureReporter.failure).not.toHaveBeenCalled();
  });
});
