#!/usr/bin/env node
import { runObserverMain } from "@station/observer";
import { type CreateProviderRegistryOptions, createProviderRegistry } from "./observerProviders.js";
import { resolveDefaultIngressLauncher } from "./worktrunkHookExpectation.js";

export type RunCliObserverMainOptions = {
  preparePiExtension?: (stateDir: string) => string | Promise<string>;
  providerHookIngressLauncher?: string;
};

/**
 * COMPOSITION ROOT
 *
 * Chooses CLI-owned provider composition and joins it to the Observer runtime lifecycle.
 */
export async function runCliObserverMain(
  argv: readonly string[] = process.argv.slice(2),
  options: RunCliObserverMainOptions = {},
): Promise<number> {
  const providerHookIngressLauncher =
    options.providerHookIngressLauncher ?? resolveDefaultIngressLauncher();
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
      return createProviderRegistry(config, registryOptions);
    },
  });
}

async function runCliObserverProcess(): Promise<void> {
  try {
    process.exitCode = await runCliObserverMain();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  void runCliObserverProcess();
}
