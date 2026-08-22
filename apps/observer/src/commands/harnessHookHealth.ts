import {
  type ProviderHookHealth,
  ProviderHookHealthSchema,
  type ProviderId,
} from "@station/contracts";
import { toSafeError } from "../diagnostics/errors.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { resolveHarnessProviderOrThrow } from "./providers.js";

export type ReadHarnessHookHealthOptions = {
  providers: ProviderRegistry;
  providerId: ProviderId;
  stationConfigPath?: string | undefined;
};

/**
 * USE CASE
 *
 * Reads provider-neutral hook evidence without invoking any mutation capability.
 */
export async function readHarnessHookHealth(
  options: ReadHarnessHookHealthOptions,
): Promise<ProviderHookHealth> {
  const provider = resolveHarnessProviderOrThrow(options.providers, options.providerId);
  if (provider.hookHealth === undefined) {
    return ProviderHookHealthSchema.parse({ provider: provider.id, status: "unsupported" });
  }

  try {
    const context =
      options.stationConfigPath === undefined
        ? undefined
        : { stationConfigPath: options.stationConfigPath };
    return ProviderHookHealthSchema.parse(await provider.hookHealth(context));
  } catch (error) {
    return ProviderHookHealthSchema.parse({
      provider: provider.id,
      status: "inspection-failed",
      error: toSafeError(error, {
        tag: "HarnessProviderError",
        code: "HARNESS_HOOK_INSPECTION_FAILED",
        message: "STATION could not inspect the configured harness hooks.",
        provider: provider.id,
      }),
      followUp: { action: "run-doctor" },
    });
  }
}
