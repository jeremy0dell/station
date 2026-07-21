#!/usr/bin/env node
import { runObserverMain } from "@station/observer";
import { type CreateProviderRegistryOptions, createProviderRegistry } from "./observerProviders.js";

export type RunCliObserverMainOptions = {
  preparePiExtension?: (stateDir: string) => string | Promise<string>;
  providerHookIngressLauncher?: string;
};

/**
 * ADAPTER
 *
 * Translates raw process arguments plus compiled asset and provider-hook launcher
 * inputs into CLI-owned Observer provider composition.
 */
export async function runCliObserverMain(
  argv: readonly string[] = process.argv.slice(2),
  options: RunCliObserverMainOptions = {},
): Promise<number> {
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
      if (options.providerHookIngressLauncher !== undefined) {
        registryOptions.providerHookIngressLauncher = options.providerHookIngressLauncher;
      }
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
