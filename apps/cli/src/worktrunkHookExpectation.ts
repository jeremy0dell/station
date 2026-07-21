import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveObserverPaths, type StationConfig } from "@station/config";
import type { ProviderHookRuntime } from "@station/contracts";
import { isCompiledBinary } from "@station/runtime";
import type { WorktrunkHookExpectation } from "@station/worktrunk";

export type ProviderHookRuntimeOptions = {
  stationConfigPath?: string | undefined;
  ingressLauncher?: string | undefined;
  compiled?: boolean | undefined;
  execPath?: string | undefined;
  sourceRoot?: string | undefined;
};

/** Builds the one Worktrunk hook expectation shared by CLI setup and provider diagnostics. */
export function createWorktrunkHookExpectation(
  config: StationConfig,
  options: ProviderHookRuntimeOptions = {},
): WorktrunkHookExpectation {
  const runtime = createProviderHookRuntime(config, options);
  const expectation: WorktrunkHookExpectation = {
    hookBin: runtime.ingressLauncher,
    observerSocketPath: runtime.observerSocketPath,
    stateDir: runtime.stateDir,
    hookSpoolDir: runtime.hookSpoolDir,
    autoStartFromHooks: runtime.autoStartFromHooks,
  };
  if (runtime.stationConfigPath !== undefined) {
    expectation.stationConfigPath = runtime.stationConfigPath;
  }
  return expectation;
}

export function createProviderHookRuntime(
  config: StationConfig | undefined,
  options: ProviderHookRuntimeOptions = {},
): ProviderHookRuntime {
  const observerPaths = resolveObserverPaths(config);
  const runtime: ProviderHookRuntime = {
    ingressLauncher: options.ingressLauncher ?? resolveDefaultIngressLauncher(options),
    observerSocketPath: observerPaths.socketPath,
    stateDir: observerPaths.stateDir,
    hookSpoolDir: observerPaths.hookSpoolDir,
    autoStartFromHooks: config?.observer?.autoStartFromHooks !== false,
  };
  if (options.stationConfigPath !== undefined) {
    runtime.stationConfigPath = options.stationConfigPath;
  }
  return runtime;
}

export function resolveDefaultIngressLauncher(
  options: Pick<ProviderHookRuntimeOptions, "compiled" | "execPath" | "sourceRoot"> = {},
): string {
  if (options.compiled ?? isCompiledBinary()) {
    return join(dirname(options.execPath ?? process.execPath), "stn-ingress");
  }
  const sourceRoot =
    options.sourceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return join(sourceRoot, "bin", "stn-ingress");
}
