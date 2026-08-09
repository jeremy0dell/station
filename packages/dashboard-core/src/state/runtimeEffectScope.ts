export type DashboardRuntimeEffect = () => void | Promise<void>;
export type DashboardRuntimeTimer = ReturnType<typeof setTimeout>;

/** Runtime-local admission, task settlement, and timer ownership for one dashboard. */
export type DashboardRuntimeEffectScope = {
  isOpen(): boolean;
  /** Start and register an effect only while the runtime still admits work. */
  run(effect: DashboardRuntimeEffect): boolean;
  /** Apply a synchronous state mutation only while the runtime remains open. */
  commit(mutation: () => void): boolean;
  /** Schedule one owned timer only while the runtime remains open. */
  setTimeout(effect: DashboardRuntimeEffect, delayMs: number): DashboardRuntimeTimer | undefined;
  clearTimeout(timer: DashboardRuntimeTimer): void;
  /** Close effect admission without waiting for already-started work. */
  close(): void;
  /** Clear timers and repeat-safely await every effect admitted before closure. */
  dispose(): Promise<void>;
};

/** Create the private lifetime scope used by one dashboard runtime. */
export function createDashboardRuntimeEffectScope(): DashboardRuntimeEffectScope {
  const inFlight = new Set<Promise<void>>();
  const timers = new Set<DashboardRuntimeTimer>();
  let open = true;
  let disposal: Promise<void> | undefined;

  const run = (effect: DashboardRuntimeEffect): boolean => {
    if (!open) {
      return false;
    }

    let task: Promise<void>;
    try {
      task = Promise.resolve(effect());
    } catch (error: unknown) {
      task = Promise.reject(error);
    }
    inFlight.add(task);
    const release = (): void => {
      inFlight.delete(task);
    };
    task.then(release, release);
    return true;
  };

  const clearOwnedTimeout = (timer: DashboardRuntimeTimer): void => {
    if (!timers.delete(timer)) {
      return;
    }
    globalThis.clearTimeout(timer);
  };

  return {
    isOpen: () => open,
    run,
    commit: (mutation): boolean => {
      if (!open) {
        return false;
      }
      mutation();
      return true;
    },
    setTimeout: (effect, delayMs) => {
      if (!open) {
        return undefined;
      }
      let timer: DashboardRuntimeTimer;
      timer = globalThis.setTimeout(() => {
        timers.delete(timer);
        run(effect);
      }, delayMs);
      timers.add(timer);
      return timer;
    },
    clearTimeout: clearOwnedTimeout,
    close: (): void => {
      open = false;
    },
    dispose: (): Promise<void> => {
      if (disposal !== undefined) {
        return disposal;
      }
      // Close admission before snapshotting tasks so settlement has a fixed boundary.
      open = false;
      for (const timer of timers) {
        globalThis.clearTimeout(timer);
      }
      timers.clear();
      disposal = Promise.allSettled([...inFlight]).then(() => undefined);
      return disposal;
    },
  };
}
