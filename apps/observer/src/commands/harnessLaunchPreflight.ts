import type { ProviderId, SafeError } from "@station/contracts";
import type { ProviderRegistry } from "../providers/registry.js";
import { throwIfAborted } from "./cancellation.js";
import { reconcileHarnessHooksOrThrow } from "./harnessHookReconciliation.js";
import { assertHooksInstalledOrThrow, resolveHarnessProviderOrThrow } from "./providers.js";

export type HarnessLaunchPreflight = (
  providerId: ProviderId,
  signal?: AbortSignal,
) => Promise<void>;

export type HarnessLaunchPreflightOptions = {
  providers: ProviderRegistry;
  providerId: ProviderId;
  stationConfigPath?: string | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * USE CASE
 *
 * Freshly verifies the selected harness health, reconciles configured hooks, and verifies delivery
 * immediately before launch mutation.
 */
export async function assertHarnessLaunchPreconditionsOrThrow(
  options: HarnessLaunchPreflightOptions,
): Promise<void> {
  if (options.signal !== undefined) {
    throwIfAborted(options.signal);
  }
  const provider = resolveHarnessProviderOrThrow(options.providers, options.providerId);
  if (!provider.capabilities().canLaunch) {
    throw harnessUnavailableError(provider.id);
  }

  await options.providers.healthCache.refresh(provider.id);
  if (options.signal !== undefined) {
    throwIfAborted(options.signal);
  }
  const health = options.providers.healthCache.read(provider.id);
  if (health?.status === "unavailable") {
    throw health.lastError ?? harnessUnavailableError(provider.id);
  }

  await reconcileHarnessHooksOrThrow({
    providers: options.providers,
    providerId: provider.id,
    ...(options.stationConfigPath === undefined
      ? {}
      : { stationConfigPath: options.stationConfigPath }),
  });
  if (options.signal !== undefined) {
    throwIfAborted(options.signal);
  }

  await assertHooksInstalledOrThrow(
    provider,
    options.stationConfigPath === undefined ? {} : { stationConfigPath: options.stationConfigPath },
  );
  if (options.signal !== undefined) {
    throwIfAborted(options.signal);
  }
}

function harnessUnavailableError(providerId: ProviderId): SafeError {
  return {
    tag: "HarnessProviderError",
    code: "HARNESS_PROVIDER_UNAVAILABLE",
    message: "The requested harness provider is unavailable for launch.",
    provider: providerId,
  };
}
