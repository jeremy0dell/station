import type { TuiToast } from "../services/types.js";

export const FAILED_CREATE_ROW_TTL_MS = 4_000;
export const OBSERVER_RECOVERY_TOAST_THRESHOLD_MS = 1_500;

export const TOAST_EXPIRY_MS_BY_KIND = {
  success: 2_400,
  info: 3_200,
} as const satisfies Partial<Record<TuiToast["kind"], number>>;

export function toastExpiryMs(kind: TuiToast["kind"]): number | undefined {
  return kind === "error" ? undefined : TOAST_EXPIRY_MS_BY_KIND[kind];
}
