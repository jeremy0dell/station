import { safeErrorToNotice, toSafeError as toClientSafeError } from "@station/client";
import type { SafeError } from "@station/contracts";

export const safeErrorToToast = safeErrorToNotice;

export type ToSafeErrorOptions = {
  clientLabel?: string;
};

export function toSafeError(error: unknown, options: ToSafeErrorOptions = {}): SafeError {
  const clientLabel = options.clientLabel ?? "TUI";
  return toClientSafeError(error, { clientLabel });
}

/**
 * Value equality for two SafeErrors. SafeError is a flat record of optional
 * strings, so a shallow key compare is exact — any differing field is a
 * genuinely different error. Used to coalesce equal-but-freshly-allocated
 * errors (e.g. a source re-deriving the same failure on every notify).
 */
export function safeErrorEquals(a: SafeError | undefined, b: SafeError | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof SafeError>;
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}
