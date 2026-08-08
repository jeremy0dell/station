import type { StoreApi } from "zustand/vanilla";
import { removeExpiredFailedCreateSessionRows } from "../localRows.js";
import type { DashboardRuntimeEffectScope, DashboardRuntimeTimer } from "../runtimeEffectScope.js";
import type { DashboardState } from "../types.js";

export type FailedCreateExpiryScheduler = {
  /** Retarget the sole timer to the earliest failed-row deadline. */
  schedule(): void;
};

/** Create the single failed-create expiry scheduler owned by a dashboard scope. */
export function createFailedCreateExpiryScheduler(input: {
  getStore: () => StoreApi<DashboardState>;
  scope: DashboardRuntimeEffectScope;
  now?: () => number;
}): FailedCreateExpiryScheduler {
  const now = input.now ?? Date.now;
  let timer: DashboardRuntimeTimer | undefined;

  const clearTimer = (): void => {
    if (timer === undefined) {
      return;
    }
    input.scope.clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    clearTimer();
    if (!input.scope.isOpen()) {
      return;
    }
    const earliest = input
      .getStore()
      .getState()
      .localRows.failedCreate.reduce<number | undefined>(
        (deadline, row) =>
          deadline === undefined || row.expiresAt < deadline ? row.expiresAt : deadline,
        undefined,
      );
    if (earliest === undefined) {
      return;
    }
    timer = input.scope.setTimeout(
      () => {
        timer = undefined;
        const expiredAt = now();
        input.scope.commit(() => {
          const store = input.getStore();
          store.setState(removeExpiredFailedCreateSessionRows(store.getState(), expiredAt));
        });
        schedule();
      },
      Math.max(0, earliest - now()),
    );
  };

  return { schedule };
}
