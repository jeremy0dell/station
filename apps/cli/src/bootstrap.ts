#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import type { CliRunOptions } from "./cliTypes.js";
import { isTopLevelCliCommand } from "./topLevelCliCommands.js";

type CliBootstrapDeps = {
  enableCompileCache: () => unknown;
  loadBuildInfo: () => Promise<{
    stationBuildInfoAsync: typeof import("@station/runtime/build-info").stationBuildInfoAsync;
  }>;
  loadCliProcess: (argv: readonly string[]) => Promise<{
    runCliMain: (argv: readonly string[], options: CliRunOptions) => Promise<void>;
  }>;
};

const defaultDeps: CliBootstrapDeps = {
  enableCompileCache,
  loadBuildInfo: () => import("@station/runtime/build-info"),
  loadCliProcess: (argv) =>
    isCommandDispatchInvocation(argv)
      ? import("./commandDispatchProcess.js")
      : import("./cliProcess.js"),
};

export function isCommandDispatchInvocation(argv: readonly string[]): boolean {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h" || arg === "--man") return false;
    if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--") || isTopLevelCliCommand(value)) {
        return false;
      }
      index += 1;
    } else if (arg !== undefined) {
      args.push(arg);
    }
  }
  return args[0] === "command" && args[1] === "dispatch";
}

/**
 * Loads the runtime-specific admission boundary before starting exact verification beside the heavy
 * CLI graph; execution still awaits validated build information from the active source runtime.
 */
export async function runCliBootstrap(
  argv: readonly string[] = process.argv.slice(2),
  deps: CliBootstrapDeps = defaultDeps,
): Promise<void> {
  try {
    deps.enableCompileCache();
  } catch {
    // Cache admission is optional; it must never gate command execution.
  }
  const buildInfoModule = await deps.loadBuildInfo();
  const buildInfoPromise = buildInfoModule.stationBuildInfoAsync();
  const cliProcessPromise = deps.loadCliProcess(argv);
  const cliProcess = await cliProcessPromise;
  let updateDeps: NonNullable<CliRunOptions["updateDeps"]>;
  try {
    updateDeps = { currentBuildInfo: await buildInfoPromise };
  } catch (error) {
    updateDeps = {
      buildInfo: () => {
        throw error;
      },
    };
  }
  await cliProcess.runCliMain(argv, { updateDeps });
}

if (import.meta.main) {
  void runCliBootstrap();
}
