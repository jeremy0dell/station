import {
  type ProviderHookArtifactOwner,
  type ProviderHookArtifactOwnership,
  type ProviderHookHealth,
  ProviderHookHealthSchema,
  type ProviderHookReconciliationResult,
  type ProviderId,
  type SafeError,
} from "@station/contracts";
import {
  ProviderHookArtifactOwnershipError,
  publicSafeErrorFromUnknown,
  withProviderHookMutationLock,
} from "@station/runtime";

export type DeclarativeProviderHookDoctorResult = {
  status: "ok" | "warn";
  installed: boolean;
  ownership?: ProviderHookArtifactOwnership;
};

export type DeclarativeProviderHookErrorMessages = {
  tag: string;
  inspection: { code: string; message: string };
  write: { code: string; message: string };
  verification: { code: string; message: string };
};

export type DeclarativeProviderHookWriteContext = {
  signal?: AbortSignal;
  beginMutation: () => void;
  onMutationCommitted: () => void;
};

export async function inspectDeclarativeProviderHookHealth(input: {
  provider: ProviderId;
  enabled: boolean;
  inspect: () => Promise<DeclarativeProviderHookDoctorResult>;
  errors: DeclarativeProviderHookErrorMessages;
}): Promise<ProviderHookHealth> {
  if (!input.enabled) {
    return ProviderHookHealthSchema.parse({
      provider: input.provider,
      status: "configured-disabled",
      followUp: { action: "enable-hooks" },
    });
  }
  try {
    return providerHookHealthFromDoctor(input.provider, await input.inspect());
  } catch (cause) {
    return ProviderHookHealthSchema.parse({
      provider: input.provider,
      status: "inspection-failed",
      error: providerHookError(input.provider, cause, input.errors.inspection, input.errors.tag),
      followUp: { action: "run-doctor" },
    });
  }
}

export async function reconcileDeclarativeProviderHooks(input: {
  provider: ProviderId;
  enabled: boolean;
  artifactOwner?: ProviderHookArtifactOwner;
  artifactPaths: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  beginMutation?: () => void;
  inspect: (signal?: AbortSignal) => Promise<DeclarativeProviderHookDoctorResult>;
  install: (context: DeclarativeProviderHookWriteContext) => Promise<{ changed: boolean }>;
  errors: DeclarativeProviderHookErrorMessages;
}): Promise<ProviderHookReconciliationResult> {
  if (!input.enabled) {
    return {
      provider: input.provider,
      status: "configured-disabled",
      changed: false,
      verified: false,
      followUp: { action: "enable-hooks" },
    };
  }
  if (input.artifactOwner === undefined) {
    return reconciliationFailure(
      input,
      "inspection-failed",
      false,
      new Error(`${input.provider} hook reconciliation requires verified artifact ownership.`),
    );
  }

  const boundary = createOperationBoundary(input);
  let stage: "inspection" | "write" | "verification" = "inspection";
  let changed = false;
  try {
    return await withProviderHookMutationLock(
      input.artifactPaths,
      async () => {
        const current = await input.inspect(readSignal(boundary));
        assertCanContinue(boundary);
        if (isOwnershipConflict(current.ownership)) {
          return ownershipConflict(input.provider);
        }

        stage = "write";
        const signal = readSignal(boundary);
        const installed = await input.install({
          ...(signal === undefined ? {} : { signal }),
          beginMutation: once(() => {
            assertCanContinue(boundary);
            input.beginMutation?.();
            assertCanContinue(boundary);
            boundary.mutationStarted = true;
          }),
          onMutationCommitted: () => {
            changed = true;
          },
        });
        if (installed.changed) changed = true;
        assertCanContinue(boundary);

        stage = "verification";
        const doctor = await input.inspect(readSignal(boundary));
        assertCanContinue(boundary);
        if (isOwnershipConflict(doctor.ownership)) {
          return ownershipConflict(input.provider);
        }
        if (doctor.status === "ok" && doctor.installed) {
          return changed
            ? { provider: input.provider, status: "repaired", changed: true, verified: true }
            : { provider: input.provider, status: "healthy", changed: false, verified: true };
        }
        return reconciliationFailure(
          input,
          "post-write-doctor-failed",
          changed,
          new Error(`${input.provider} hook doctor did not verify the completed reconciliation.`),
        );
      },
      lockContext(boundary),
    );
  } catch (cause) {
    if (!boundary.mutationStarted && input.signal?.aborted === true) {
      throw input.signal.reason ?? cause;
    }
    if (cause instanceof ProviderHookArtifactOwnershipError) {
      return ownershipConflict(input.provider);
    }
    return reconciliationFailure(
      input,
      stage === "inspection"
        ? "inspection-failed"
        : stage === "write"
          ? "write-failed"
          : "post-write-doctor-failed",
      changed,
      cause,
    );
  }
}

function providerHookHealthFromDoctor(
  provider: ProviderId,
  doctor: DeclarativeProviderHookDoctorResult,
): ProviderHookHealth {
  if (isOwnershipConflict(doctor.ownership)) {
    return ProviderHookHealthSchema.parse({
      provider,
      status: "ownership-conflict",
      ownership: doctor.ownership.status,
      followUp: { action: "run-explicit-takeover" },
    });
  }
  if (doctor.status === "ok" && doctor.installed) {
    return ProviderHookHealthSchema.parse({ provider, status: "healthy" });
  }
  return ProviderHookHealthSchema.parse({
    provider,
    status: "needs-repair",
    reason:
      doctor.ownership?.status === "same-owner" || doctor.installed ? "owned-drift" : "missing",
  });
}

function reconciliationFailure(
  input: { provider: ProviderId; errors: DeclarativeProviderHookErrorMessages },
  status: "inspection-failed" | "write-failed" | "post-write-doctor-failed",
  changed: boolean,
  cause: unknown,
): ProviderHookReconciliationResult {
  const detail =
    status === "inspection-failed"
      ? input.errors.inspection
      : status === "write-failed"
        ? input.errors.write
        : input.errors.verification;
  const error = providerHookError(input.provider, cause, detail, input.errors.tag);
  const base = { provider: input.provider, verified: false, error } satisfies {
    provider: ProviderId;
    verified: false;
    error: SafeError;
  };
  switch (status) {
    case "inspection-failed":
      return { ...base, status, changed: false, followUp: { action: "run-doctor" } };
    case "write-failed":
      return { ...base, status, changed, followUp: { action: "retry" } };
    case "post-write-doctor-failed":
      return { ...base, status, changed, followUp: { action: "run-doctor" } };
  }
}

function providerHookError(
  provider: ProviderId,
  cause: unknown,
  detail: { code: string; message: string },
  tag: string,
): SafeError {
  return {
    ...publicSafeErrorFromUnknown(cause, { tag, ...detail, provider }),
    provider,
  };
}

function ownershipConflict(provider: ProviderId): ProviderHookReconciliationResult {
  return {
    provider,
    status: "ownership-conflict",
    changed: false,
    verified: false,
    followUp: { action: "run-explicit-takeover" },
  };
}

function isOwnershipConflict(
  ownership: ProviderHookArtifactOwnership | undefined,
): ownership is Extract<
  ProviderHookArtifactOwnership,
  { status: "different-owner" | "unknown-owner" }
> {
  return ownership?.status === "different-owner" || ownership?.status === "unknown-owner";
}

type OperationBoundary = {
  signal?: AbortSignal;
  deadlineMs?: number;
  mutationStarted: boolean;
};

function createOperationBoundary(input: {
  signal?: AbortSignal;
  timeoutMs?: number;
}): OperationBoundary {
  const boundary: OperationBoundary = { mutationStarted: false };
  if (input.signal !== undefined) boundary.signal = input.signal;
  if (input.timeoutMs !== undefined) {
    boundary.deadlineMs = performance.now() + Math.max(0, input.timeoutMs);
  }
  return boundary;
}

function lockContext(boundary: OperationBoundary): {
  signal?: AbortSignal;
  deadlineMs?: number;
} {
  const context: { signal?: AbortSignal; deadlineMs?: number } = {};
  if (boundary.signal !== undefined) context.signal = boundary.signal;
  if (boundary.deadlineMs !== undefined) context.deadlineMs = boundary.deadlineMs;
  return context;
}

function readSignal(boundary: OperationBoundary): AbortSignal | undefined {
  return boundary.mutationStarted ? undefined : boundary.signal;
}

function assertCanContinue(boundary: OperationBoundary): void {
  if (boundary.mutationStarted) return;
  if (boundary.signal?.aborted === true) {
    throw boundary.signal.reason ?? new Error("Provider hook reconciliation was cancelled.");
  }
  if (boundary.deadlineMs !== undefined && performance.now() >= boundary.deadlineMs) {
    throw new Error("Provider hook reconciliation exceeded its deadline before mutation.");
  }
}

function once(effect: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    effect();
  };
}
