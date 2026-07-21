import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveObserverPaths, type StationConfig } from "@station/config";
import { isCompiledBinary } from "@station/runtime";
import type { WorktrunkHookExpectation } from "@station/worktrunk";

export type WorktrunkHookExpectationOptions = {
  stationConfigPath?: string | undefined;
  ingressLauncher?: string | undefined;
  compiled?: boolean | undefined;
  execPath?: string | undefined;
  sourceRoot?: string | undefined;
};

/** Builds the one Worktrunk hook expectation shared by CLI setup and provider diagnostics. */
export function createWorktrunkHookExpectation(
  config: StationConfig,
  options: WorktrunkHookExpectationOptions = {},
): WorktrunkHookExpectation {
  const observerPaths = resolveObserverPaths(config);
  const expectation: WorktrunkHookExpectation = {
    hookBin: options.ingressLauncher ?? resolveDefaultIngressLauncher(options),
    observerSocketPath: observerPaths.socketPath,
    stateDir: observerPaths.stateDir,
    hookSpoolDir: observerPaths.hookSpoolDir,
    autoStartFromHooks: config.observer?.autoStartFromHooks !== false,
  };
  if (options.stationConfigPath !== undefined) {
    expectation.stationConfigPath = options.stationConfigPath;
  }
  return expectation;
}

export function resolveDefaultIngressLauncher(
  options: Pick<WorktrunkHookExpectationOptions, "compiled" | "execPath" | "sourceRoot"> = {},
): string {
  if (options.compiled ?? isCompiledBinary()) {
    return join(dirname(options.execPath ?? process.execPath), "stn-ingress");
  }
  const sourceRoot =
    options.sourceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return join(sourceRoot, "bin", "stn-ingress");
}
