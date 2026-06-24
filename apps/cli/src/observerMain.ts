#!/usr/bin/env node
import { runObserverMain } from "@station/observer";
import { createProviderRegistry } from "./observerProviders.js";

export async function runCliObserverMain(argv = process.argv.slice(2)): Promise<number> {
  return runObserverMain(argv, { providerRegistryFactory: createProviderRegistry });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCliObserverMain()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
