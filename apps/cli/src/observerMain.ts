#!/usr/bin/env node
import { runObserverMain } from "@station/observer";
import { createProviderRegistry } from "./observerProviders.js";

/**
 * Receives raw observer arguments and delegates provider composition to the
 * Observer bootstrap.
 */
export async function runCliObserverMain(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  return runObserverMain([...argv], { providerRegistryFactory: createProviderRegistry });
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
