#!/usr/bin/env node
import type { ProviderHookArtifactOwner } from "@station/contracts";
import { type ObserverStartupReadinessSink, runObserverMain } from "@station/observer";
import { providerHookArtifactOwner, stationBuildInfo } from "@station/runtime";
import {
  createObserverStartupFailureReporter,
  type ObserverStartupFailureReporter,
} from "./observerProcess/failureReport.js";
import { type CreateProviderRegistryOptions, createProviderRegistry } from "./observerProviders.js";
import { resolveDefaultIngressLauncher } from "./worktrunkHookExpectation.js";

export type RunCliObserverMainOptions = {
  preparePiExtension?: (stateDir: string) => string | Promise<string>;
  providerHookIngressLauncher?: string;
  providerHookArtifactOwner?: ProviderHookArtifactOwner;
  startupReadinessSink?: ObserverStartupReadinessSink;
};

type RunCliObserverProcessOptions = {
  startupFailureReporter?: ObserverStartupFailureReporter;
};

type CliObserverProcessOperation = (
  startupReadinessSink: ObserverStartupReadinessSink,
) => Promise<number>;

/**
 * COMPOSITION ROOT
 *
 * Chooses CLI-owned provider composition and joins it to the Observer runtime lifecycle,
 * including private startup-readiness notification for the spawning CLI.
 */
export async function runCliObserverMain(
  argv: readonly string[] = process.argv.slice(2),
  options: RunCliObserverMainOptions = {},
): Promise<number> {
  const providerHookIngressLauncher =
    options.providerHookIngressLauncher ?? resolveDefaultIngressLauncher();
  const artifactOwner =
    options.providerHookArtifactOwner ??
    providerHookArtifactOwner(providerHookIngressLauncher, stationBuildInfo());
  return runObserverMain([...argv], {
    providerRegistryFactory: async (config, providerOptions) => {
      const registryOptions: CreateProviderRegistryOptions = {};
      if (providerOptions.configPath !== undefined) {
        registryOptions.configPath = providerOptions.configPath;
      }
      if (options.preparePiExtension !== undefined) {
        registryOptions.piExtensionPath = await options.preparePiExtension(
          providerOptions.stateDir,
        );
      }
      registryOptions.providerHookIngressLauncher = providerHookIngressLauncher;
      registryOptions.providerHookArtifactOwner = artifactOwner;
      return createProviderRegistry(config, registryOptions);
    },
    ...(options.startupReadinessSink === undefined
      ? {}
      : { startupReadinessSink: options.startupReadinessSink }),
  });
}

/**
 * ADAPTER
 *
 * Applies one shared source/compiled Observer process boundary: typed startup
 * reporting, redacted stderr, readiness closure, and exit-code translation.
 */
export async function runCliObserverProcess(
  operation: CliObserverProcessOperation,
  options: RunCliObserverProcessOptions = {},
): Promise<number> {
  const reporter = options.startupFailureReporter ?? createObserverStartupFailureReporter();
  let reportClosed = false;
  const closeReport = (): void => {
    if (reportClosed) return;
    reportClosed = true;
    reporter.ready();
  };
  try {
    const code = await operation({ ready: closeReport });
    closeReport();
    return code;
  } catch (error) {
    const report = reporter.failure(error);
    const lines = [`${report.error.message} (${report.error.code})`];
    if (report.cause !== undefined) {
      lines.push(`Cause: ${report.cause.message} (${report.cause.code})`);
    }
    process.stderr.write(`${lines.join("\n")}\n`);
    return 1;
  }
}

if (import.meta.main) {
  void runCliObserverProcess((startupReadinessSink) =>
    runCliObserverMain(process.argv.slice(2), { startupReadinessSink }),
  ).then((code) => {
    process.exitCode = code;
  });
}
