const DEFAULT_MAX_CONCURRENT_CREATES_PER_PROJECT = 4;

export type WorktreeCreateCoordinator = {
  run<T>(projectId: string, signal: AbortSignal, create: () => Promise<T>): Promise<T>;
  /** Resolves after the project's active and queued create calls have both drained. */
  whenProjectIdle(projectId: string): Promise<void>;
  /** Resolves after active and queued create calls across every project have drained. */
  whenIdle(): Promise<void>;
};

export type CreateWorktreeCreateCoordinatorOptions = {
  maxConcurrentPerProject?: number;
};

type ProjectCreateState = {
  active: number;
  idleWaiters: Array<() => void>;
  waiting: Array<{
    signal: AbortSignal;
    start(release: () => void): void;
    reject(error: unknown): void;
    onAbort(): void;
  }>;
};

/** Bounds repository create pressure per project while preserving FIFO admission and cancellation. */
export function createWorktreeCreateCoordinator(
  options: CreateWorktreeCreateCoordinatorOptions = {},
): WorktreeCreateCoordinator {
  const maxConcurrent =
    options.maxConcurrentPerProject ?? DEFAULT_MAX_CONCURRENT_CREATES_PER_PROJECT;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("Worktree create concurrency must be a positive integer.");
  }
  const states = new Map<string, ProjectCreateState>();
  const idleWaiters: Array<() => void> = [];

  const release = (projectId: string, state: ProjectCreateState): void => {
    state.active -= 1;
    admit(projectId, state);
  };

  const admit = (projectId: string, state: ProjectCreateState): void => {
    while (state.active < maxConcurrent) {
      const waiter = state.waiting.shift();
      if (waiter === undefined) break;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        try {
          waiter.signal.throwIfAborted();
        } catch (error) {
          waiter.reject(error);
        }
        continue;
      }
      state.active += 1;
      waiter.start(() => release(projectId, state));
    }
    if (state.active === 0 && state.waiting.length === 0) {
      states.delete(projectId);
      for (const resolveIdle of state.idleWaiters.splice(0)) resolveIdle();
      if (states.size === 0) {
        for (const resolveIdle of idleWaiters.splice(0)) resolveIdle();
      }
    }
  };

  const acquire = (projectId: string, signal: AbortSignal): Promise<() => void> => {
    signal.throwIfAborted();
    const state = states.get(projectId) ?? { active: 0, idleWaiters: [], waiting: [] };
    states.set(projectId, state);
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        signal,
        start: resolve,
        reject,
        onAbort: () => {
          const index = state.waiting.indexOf(waiter);
          if (index === -1) return;
          state.waiting.splice(index, 1);
          try {
            signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
          admit(projectId, state);
        },
      };
      state.waiting.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      admit(projectId, state);
    });
  };

  return {
    async run<T>(projectId: string, signal: AbortSignal, create: () => Promise<T>): Promise<T> {
      const releaseSlot = await acquire(projectId, signal);
      try {
        signal.throwIfAborted();
        return await create();
      } finally {
        releaseSlot();
      }
    },

    whenProjectIdle: (projectId) => {
      const state = states.get(projectId);
      if (state === undefined || (state.active === 0 && state.waiting.length === 0)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => state.idleWaiters.push(resolve));
    },

    whenIdle: () => {
      if (states.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
