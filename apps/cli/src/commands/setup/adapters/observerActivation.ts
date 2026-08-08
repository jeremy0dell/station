import { loadConfig, resolveObserverPaths } from "@station/config";
import { publicSafeErrorFromUnknown, safeErrorFromUnknown } from "@station/runtime";
import type { SetupObserverActivationPort } from "@station/setup-core";
import { restartObserver } from "../../../observerProcess.js";

export type SetupObserverActivationAdapterOptions = {
  readonly configPath: () => string | undefined;
  readonly homeDir: string;
  /** Receives delayed Observer startup progress lines during activation. */
  readonly onStartupProgress?: (message: string) => void;
  readonly activateObserverConfig?: (input: {
    configPath: string;
    homeDir: string;
    onStartupProgress?: (message: string) => void;
  }) => Promise<void>;
};

/**
 * ADAPTER
 *
 * Translates setup activation into config loading, Observer path resolution, restart, and health confirmation.
 * Forwards Observer startup progress to the caller-supplied callback without interpreting it.
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
      await (options.activateObserverConfig ?? activateObserverConfig)({
        configPath,
        homeDir: options.homeDir,
        ...(options.onStartupProgress === undefined
          ? {}
          : { onStartupProgress: options.onStartupProgress }),
      });
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
}): Promise<void> {
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
      throw safeErrorFromUnknown(status.error, observerActivationError);
    }
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
  error: ReturnType<typeof publicSafeErrorFromUnknown>,
) {
  return { status: "failed" as const, operationId, error };
}
