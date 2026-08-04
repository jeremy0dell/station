import type { ClientNotice } from "../services/types.js";

export const FAILED_CREATE_ROW_TTL_MS = 4_000;
export const OBSERVER_RECOVERY_TOAST_THRESHOLD_MS = 1_500;
export const ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS = 1_000;

export const TOAST_EXPIRY_MS_BY_KIND = {
  success: 2_400,
  info: 3_200,
  error: 16_000,
} as const satisfies Record<ClientNotice["kind"], number>;

export function toastExpiryMs(kind: ClientNotice["kind"]): number {
  return TOAST_EXPIRY_MS_BY_KIND[kind];
}
