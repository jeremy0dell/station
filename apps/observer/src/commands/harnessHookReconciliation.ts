import {
  type ProviderHookReconciliationContext,
  type ProviderHookReconciliationResult,
  ProviderHookReconciliationResultSchema,
  type ProviderId,
  providerHookReconciliationSucceeded,
  type SafeError,
  type SuccessfulProviderHookReconciliationResult,
} from "@station/contracts";
import { toSafeError } from "../diagnostics/errors.js";
import type { ProviderRegistry } from "../providers/registry.js";

export type ReconcileHarnessHooksOptions = {
  providers: ProviderRegistry;
  providerId: ProviderId;
  stationConfigPath?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  beginMutation?: (() => void) | undefined;
};

/**
 * USE CASE
 *
 * Requests one provider-owned reconciliation and returns its provider-neutral result.
 */
export async function reconcileHarnessHooks(
  options: ReconcileHarnessHooksOptions,
): Promise<ProviderHookReconciliationResult> {
  const provider = options.providers.harnesses.get(options.providerId);
  if (provider === undefined) {
    return hookReconciliationFailure(options.providerId, {
      tag: "HarnessProviderError",
      code: "HARNESS_PROVIDER_UNAVAILABLE",
      message: "The requested harness provider is not registered.",
      provider: options.providerId,
    });
  }
  if (provider.id !== options.providerId) {
    return hookReconciliationFailure(options.providerId, invalidReconciliationResult());
  }
  const context = providerReconciliationContext(options);
  const reconcile = provider.reconcileHooks?.bind(provider, context);
  return reconcileProviderHooks(options.providerId, reconcile);
}

/**
 * USE CASE
 *
 * Requests one provider-owned reconciliation and rejects every unverified enabled outcome.
 */
export async function reconcileHarnessHooksOrThrow(
  options: ReconcileHarnessHooksOptions,
): Promise<ProviderHookReconciliationResult> {
  const result = await reconcileHarnessHooks(options);
  if (providerHookReconciliationSucceeded(result)) return result;
  throw reconciliationError(result);
}

/**
 * USE CASE
 *
 * Reconciles all configured provider hooks within one Observer startup budget.
 */
export async function reconcileConfiguredHarnessHooksOrThrow(options: {
  providers: ProviderRegistry;
  stationConfigPath?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}): Promise<ProviderHookReconciliationResult[]> {
  const results: ProviderHookReconciliationResult[] = [];
  const deadline =
    options.timeoutMs === undefined
      ? undefined
      : performance.now() + Math.max(0, options.timeoutMs);
  for (const providerId of options.providers.harnesses.keys()) {
    throwIfHookReconciliationAborted(options.signal);
    const timeoutMs = remainingHookReconciliationMs(deadline);
    results.push(
      await reconcileHarnessHooksOrThrow({
        ...options,
        providerId,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    );
  }
  return results;
}

/**
 * USE CASE
 *
 * Admits only canonical requested-provider results from one provider callback.
 */
export async function reconcileProviderHooks(
  providerId: ProviderId,
  reconcile: (() => Promise<unknown>) | undefined,
): Promise<ProviderHookReconciliationResult> {
  if (reconcile === undefined) {
    return {
      provider: providerId,
      status: "unsupported",
      changed: false,
      verified: false,
    };
  }

  let untrustedResult: unknown;
  try {
    untrustedResult = await reconcile();
  } catch (cause) {
    return hookReconciliationFailure(providerId, cause);
  }

  const parsed = ProviderHookReconciliationResultSchema.safeParse(untrustedResult);
  if (
    !parsed.success ||
    parsed.data.provider !== providerId ||
    ("error" in parsed.data &&
      parsed.data.error.provider !== undefined &&
      parsed.data.error.provider !== providerId)
  ) {
    return hookReconciliationFailure(providerId, invalidReconciliationResult());
  }
  return parsed.data;
}

const invalidReconciliationResult = (): SafeError => ({
  tag: "HarnessProviderError",
  code: "HARNESS_HOOK_RECONCILIATION_INVALID_RESULT",
  message: "Harness hook reconciliation returned invalid provider-neutral evidence.",
});

function throwIfHookReconciliationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Harness hook reconciliation was cancelled.");
  }
}

function remainingHookReconciliationMs(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  const remaining = deadline - performance.now();
  if (remaining > 0) return remaining;
  const error: SafeError = {
    tag: "TimeoutError",
    code: "HARNESS_HOOK_RECONCILIATION_TIMEOUT",
    message: "Configured harness hook reconciliation exceeded its startup budget.",
  };
  throw Object.assign(new Error(error.message), error);
}

function providerReconciliationContext(input: {
  stationConfigPath?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  beginMutation?: (() => void) | undefined;
}): ProviderHookReconciliationContext | undefined {
  const context: ProviderHookReconciliationContext = {};
  if (input.stationConfigPath !== undefined) context.stationConfigPath = input.stationConfigPath;
  if (input.signal !== undefined) context.signal = input.signal;
  if (input.timeoutMs !== undefined) context.timeoutMs = input.timeoutMs;
  if (input.beginMutation !== undefined) context.beginMutation = input.beginMutation;
  return Object.keys(context).length === 0 ? undefined : context;
}

function hookReconciliationFailure(
  provider: ProviderId,
  cause: unknown,
): ProviderHookReconciliationResult {
  const normalized = toSafeError(cause, {
    tag: "HarnessProviderError",
    code: "HARNESS_HOOK_RECONCILIATION_FAILED",
    message: "Configured harness hooks could not be reconciled.",
    provider,
  });
  const error: SafeError = { ...normalized, provider };
  return {
    provider,
    status: "inspection-failed",
    changed: false,
    verified: false,
    error,
    followUp: { action: "run-doctor" },
  };
}

function reconciliationError(
  result: Exclude<ProviderHookReconciliationResult, SuccessfulProviderHookReconciliationResult>,
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
