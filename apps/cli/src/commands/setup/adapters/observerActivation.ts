import { loadConfig, resolveObserverPaths } from "@station/config";
import { publicSafeErrorFromUnknown, safeErrorFromUnknown } from "@station/runtime";
import type { SetupObserverActivationPort } from "@station/setup-core";
import { restartObserver } from "../../../observerProcess.js";

export type SetupObserverActivationAdapterOptions = {
  readonly configPath: () => string | undefined;
  readonly homeDir: string;
  readonly activateObserverConfig?: (input: {
    configPath: string;
    homeDir: string;
  }) => Promise<void>;
};

/**
 * ADAPTER
 *
 * Translates setup activation into config loading, Observer path resolution, restart, and health confirmation.
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
}): Promise<void> {
  try {
    const loaded = await loadConfig({ configPath: input.configPath, homeDir: input.homeDir });
    const paths = resolveObserverPaths(loaded.config, input.homeDir);
    const status = await restartObserver({
      config: loaded.config,
      configPath: loaded.configPath,
      paths,
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
