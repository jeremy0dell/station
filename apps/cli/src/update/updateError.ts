import {
  isSafeError,
  normalizeCancellationError,
  type RuntimeSafeError,
  type RuntimeSafeErrorFallback,
  safeErrorFromUnknown,
} from "@station/runtime";

export type UpdateErrorFallback = {
  code: string;
  message: string;
  hint?: string;
};

export function updateErrorFromUnknown(
  error: unknown,
  fallback: UpdateErrorFallback,
  preserveUpdateError = true,
): RuntimeSafeError {
  const cancellation = normalizeCancellationError(error);
  if (cancellation !== undefined) return cancellation;

  if (preserveUpdateError && isSafeError(error) && error.tag === "UpdateError") {
    return safeErrorFromUnknown(error, {
      tag: "UpdateError",
      code: fallback.code,
      message: fallback.message,
    });
  }

  const safeFallback: RuntimeSafeErrorFallback = {
    tag: "UpdateError",
    code: fallback.code,
    message: fallback.message,
  };
  if (fallback.hint !== undefined) safeFallback.hint = fallback.hint;
  const cause = safeErrorFromUnknown(error, safeFallback);
  const normalized: RuntimeSafeError = {
    tag: "UpdateError",
    code: fallback.code,
    message: fallback.message,
  };
  const hint = cause.hint ?? fallback.hint;
  if (hint !== undefined) normalized.hint = hint;
  if (cause.diagnosticDetails !== undefined) {
    normalized.diagnosticDetails = cause.diagnosticDetails;
  }
  return normalized;
}

export function appendUpdateErrorHint(error: RuntimeSafeError, hint: string): RuntimeSafeError {
  const normalized: RuntimeSafeError = { ...error };
  normalized.hint = error.hint === undefined ? hint : `${error.hint} ${hint}`;
  return normalized;
}
