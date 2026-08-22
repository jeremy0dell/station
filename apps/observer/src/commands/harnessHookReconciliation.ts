import type {
  HarnessProvider,
  ProviderHookReconciliationResult,
  ProviderId,
  SafeError,
} from "@station/contracts";
import { toSafeError } from "../diagnostics/errors.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { resolveHarnessProviderOrThrow } from "./providers.js";

export type ReconcileHarnessHooksOptions = {
  providers: ProviderRegistry;
  providerId: ProviderId;
  stationConfigPath?: string | undefined;
};

/**
 * USE CASE
 *
 * Requests one provider-owned reconciliation and rejects every unverified enabled outcome.
 */
export async function reconcileHarnessHooksOrThrow(
  options: ReconcileHarnessHooksOptions,
): Promise<ProviderHookReconciliationResult> {
  const provider = resolveHarnessProviderOrThrow(options.providers, options.providerId);
  return reconcileProviderHooksOrThrow(provider, options.stationConfigPath);
}

/** Reconciles every composed provider capability before Observer startup is published healthy. */
export async function reconcileConfiguredHarnessHooksOrThrow(options: {
  providers: ProviderRegistry;
  stationConfigPath?: string | undefined;
}): Promise<ProviderHookReconciliationResult[]> {
  const results: ProviderHookReconciliationResult[] = [];
  for (const provider of options.providers.harnesses.values()) {
    results.push(await reconcileProviderHooksOrThrow(provider, options.stationConfigPath));
  }
  return results;
}

async function reconcileProviderHooksOrThrow(
  provider: HarnessProvider,
  stationConfigPath: string | undefined,
): Promise<ProviderHookReconciliationResult> {
  if (provider.reconcileHooks === undefined) {
    return {
      provider: provider.id,
      status: "unsupported",
      changed: false,
      verified: false,
    };
  }

  let result: ProviderHookReconciliationResult;
  try {
    const context = stationConfigPath === undefined ? undefined : { stationConfigPath };
    result = await provider.reconcileHooks(context);
  } catch (error) {
    throw toSafeError(error, {
      tag: "HarnessProviderError",
      code: "HARNESS_HOOK_RECONCILIATION_FAILED",
      message: "Configured harness hooks could not be reconciled.",
      provider: provider.id,
    });
  }

  switch (result.status) {
    case "configured-disabled":
    case "unsupported":
    case "healthy":
    case "repaired":
      return result;
    case "ownership-conflict":
    case "write-failed":
    case "post-write-doctor-failed":
    case "inspection-failed":
      throw reconciliationError(result);
  }
}

function reconciliationError(
  result: Extract<
    ProviderHookReconciliationResult,
    {
      status:
        | "ownership-conflict"
        | "write-failed"
        | "post-write-doctor-failed"
        | "inspection-failed";
    }
  >,
): SafeError {
  const error: SafeError =
    "error" in result
      ? { ...result.error }
      : {
          tag: "HarnessProviderError",
          code: "HARNESS_HOOK_OWNERSHIP_CONFLICT",
          message: "Configured harness hooks are owned by another runtime.",
          provider: result.provider,
        };
  if (error.provider === undefined) error.provider = result.provider;
  if (error.hint === undefined) error.hint = followUpHint(result.provider, result.followUp.action);
  return error;
}

function followUpHint(
  provider: ProviderId,
  action: "enable-hooks" | "run-doctor" | "run-explicit-takeover" | "retry",
): string {
  switch (action) {
    case "enable-hooks":
      return `Enable configured hook installation for ${provider}, then retry.`;
    case "run-doctor":
      return `Use ${provider} provider hook doctor, correct the reported issue, then retry.`;
    case "run-explicit-takeover":
      return `Use the explicit ${provider} provider hook install takeover flow only to transfer ownership, then retry.`;
    case "retry":
      return `Retry ${provider} hook reconciliation after correcting the write failure.`;
  }
}
