import { loadConfig, resolveObserverPaths } from "@station/config";
import type { ObserverLifecycleFailure } from "@station/contracts";
import { publicSafeErrorFromUnknown, safeErrorFromUnknown } from "@station/runtime";
import type { SetupObserverActivationPort } from "@station/setup-core";
import { observerLifecycleFailure, restartObserver } from "../../../observerProcess.js";

export type SetupObserverActivationAdapterOptions = {
  readonly configPath: () => string | undefined;
  readonly homeDir: string;
  /** Receives delayed Observer startup progress lines during activation. */
  readonly onStartupProgress?: (message: string) => void;
  readonly activateObserverConfig?: (input: {
    configPath: string;
    homeDir: string;
    onStartupProgress?: (message: string) => void;
  }) => Promise<ObserverLifecycleFailure | undefined>;
};

/**
 * ADAPTER
 *
 * Translates setup activation into config loading, Observer path resolution, restart, and health confirmation.
 * Forwards startup progress and retains lifecycle cause/evidence without interpreting either.
 */
export function createObserverActivationAdapter(
  options: SetupObserverActivationAdapterOptions,
): SetupObserverActivationPort {
  return async (operation) => {
    const configPath = options.configPath();
    if (configPath === undefined) {
      return failedActivation(operation.id, observerActivationError);
    }
    try {
      const lifecycleFailure = await (options.activateObserverConfig ?? activateObserverConfig)({
        configPath,
        homeDir: options.homeDir,
        ...(options.onStartupProgress === undefined
          ? {}
          : { onStartupProgress: options.onStartupProgress }),
      });
      if (lifecycleFailure !== undefined) {
        return failedActivation(operation.id, lifecycleFailure);
      }
      return {
        status: "completed",
        operationId: operation.id,
        commit: { kind: "observer-activation", configPath },
      };
    } catch (error) {
      return failedActivation(
        operation.id,
        publicSafeErrorFromUnknown(error, observerActivationError),
      );
    }
  };
}

async function activateObserverConfig(input: {
  configPath: string;
  homeDir: string;
  onStartupProgress?: (message: string) => void;
}): Promise<ObserverLifecycleFailure | undefined> {
  try {
    const loaded = await loadConfig({ configPath: input.configPath, homeDir: input.homeDir });
    const paths = resolveObserverPaths(loaded.config, input.homeDir);
    const status = await restartObserver({
      config: loaded.config,
      configPath: loaded.configPath,
      paths,
      ...(input.onStartupProgress === undefined
        ? {}
        : { onStartupProgress: input.onStartupProgress }),
    });
    if (status.status !== "running") {
      return observerLifecycleFailure(status);
    }
    return undefined;
  } catch (error) {
    throw safeErrorFromUnknown(error, observerActivationError);
  }
}

const observerActivationError = {
  tag: "ObserverActivationError",
  code: "OBSERVER_ACTIVATION_FAILED",
  message: "Observer configuration could not be activated.",
} as const;

function failedActivation(
  operationId: "activate-observer-config",
  failure: ReturnType<typeof publicSafeErrorFromUnknown> | ObserverLifecycleFailure,
) {
  if ("error" in failure) {
    return {
      status: "failed" as const,
      operationId,
      error: failure.error,
      ...(failure.cause === undefined ? {} : { cause: failure.cause }),
      ...(failure.startupEvidence === undefined
        ? {}
        : { startupEvidence: failure.startupEvidence }),
    };
  }
  return { status: "failed" as const, operationId, error: failure };
}
