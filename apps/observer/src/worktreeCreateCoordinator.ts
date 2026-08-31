const DEFAULT_MAX_CONCURRENT_CREATES_PER_PROJECT = 4;

export type RunWorktreeProviderCreate = <T>(create: () => Promise<T>) => Promise<T>;

export type WorktreeCreateCoordinator = {
  run<T>(
    projectId: string,
    branch: string,
    signal: AbortSignal,
    transaction: (create: RunWorktreeProviderCreate) => Promise<T>,
  ): Promise<T>;
  isProjectIdle(projectId: string): boolean;
  whenProjectIdle(projectId: string): Promise<void>;
  isIdle(): boolean;
  whenIdle(): Promise<void>;
};

export type CreateWorktreeCreateCoordinatorOptions = {
  maxConcurrentPerProject?: number;
};

type PermitWaiter = {
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  onAbort(): void;
};

type BranchState = {
  owned: boolean;
  waiting: PermitWaiter[];
};

type ProjectCreateState = {
  transactions: number;
  activeProviderCreates: number;
  capacityWaiters: PermitWaiter[];
  branches: Map<string, BranchState>;
  idleWaiters: Array<() => void>;
};

/**
 * POLICY
 *
 * Admits provider-neutral worktree-create transactions with FIFO branch ownership and a bounded
 * per-project provider-call capacity while retaining branch ownership through downstream rollback.
 */
export function createWorktreeCreateCoordinator(
  options: CreateWorktreeCreateCoordinatorOptions = {},
): WorktreeCreateCoordinator {
  const maxConcurrent =
    options.maxConcurrentPerProject ?? DEFAULT_MAX_CONCURRENT_CREATES_PER_PROJECT;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("Worktree create concurrency must be a positive integer.");
  }

  const projects = new Map<string, ProjectCreateState>();
  const idleWaiters: Array<() => void> = [];
  let transactions = 0;

  const stateFor = (projectId: string): ProjectCreateState => {
    const existing = projects.get(projectId);
    if (existing !== undefined) return existing;
    const state: ProjectCreateState = {
      transactions: 0,
      activeProviderCreates: 0,
      capacityWaiters: [],
      branches: new Map(),
      idleWaiters: [],
    };
    projects.set(projectId, state);
    return state;
  };

  const finishTransaction = (projectId: string, state: ProjectCreateState): void => {
    state.transactions -= 1;
    transactions -= 1;
    if (state.transactions === 0) {
      projects.delete(projectId);
      for (const resolveIdle of state.idleWaiters.splice(0)) resolveIdle();
    }
    if (transactions === 0) {
      for (const resolveIdle of idleWaiters.splice(0)) resolveIdle();
    }
  };

  const admitBranch = (
    state: ProjectCreateState,
    branch: string,
    branchState: BranchState,
  ): void => {
    while (!branchState.owned) {
      const waiter = branchState.waiting.shift();
      if (waiter === undefined) {
        state.branches.delete(branch);
        return;
      }
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        rejectAbortedWaiter(waiter);
        continue;
      }
      branchState.owned = true;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        branchState.owned = false;
        admitBranch(state, branch, branchState);
      });
    }
  };

  const acquireBranch = (
    state: ProjectCreateState,
    branch: string,
    signal: AbortSignal,
  ): Promise<() => void> => {
    signal.throwIfAborted();
    const branchState = state.branches.get(branch) ?? { owned: false, waiting: [] };
    state.branches.set(branch, branchState);
    return new Promise<() => void>((resolve, reject) => {
      const waiter: PermitWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = branchState.waiting.indexOf(waiter);
          if (index === -1) return;
          branchState.waiting.splice(index, 1);
          rejectAbortedWaiter(waiter);
          admitBranch(state, branch, branchState);
        },
      };
      branchState.waiting.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      admitBranch(state, branch, branchState);
    });
  };

  const admitCapacity = (projectId: string, state: ProjectCreateState): void => {
    while (state.activeProviderCreates < maxConcurrent) {
      const waiter = state.capacityWaiters.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        rejectAbortedWaiter(waiter);
        continue;
      }
      state.activeProviderCreates += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        state.activeProviderCreates -= 1;
        admitCapacity(projectId, state);
      });
    }
  };

  const acquireCapacity = (
    projectId: string,
    state: ProjectCreateState,
    signal: AbortSignal,
  ): Promise<() => void> => {
    signal.throwIfAborted();
    return new Promise<() => void>((resolve, reject) => {
      const waiter: PermitWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = state.capacityWaiters.indexOf(waiter);
          if (index === -1) return;
          state.capacityWaiters.splice(index, 1);
          rejectAbortedWaiter(waiter);
          admitCapacity(projectId, state);
        },
      };
      state.capacityWaiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      admitCapacity(projectId, state);
    });
  };

  return {
    async run<T>(
      projectId: string,
      branch: string,
      signal: AbortSignal,
      transaction: (create: RunWorktreeProviderCreate) => Promise<T>,
    ): Promise<T> {
      signal.throwIfAborted();
      const state = stateFor(projectId);
      state.transactions += 1;
      transactions += 1;
      let releaseBranch: (() => void) | undefined;
      try {
        releaseBranch = await acquireBranch(state, branch, signal);
        signal.throwIfAborted();
        let providerCreateClaimed = false;
        const runProviderCreate: RunWorktreeProviderCreate = async (create) => {
          if (providerCreateClaimed) {
            throw new Error("A worktree-create transaction may claim exactly one provider create.");
          }
          providerCreateClaimed = true;
          const releaseCapacity = await acquireCapacity(projectId, state, signal);
          try {
            signal.throwIfAborted();
            return await create();
          } finally {
            releaseCapacity();
          }
        };
        return await transaction(runProviderCreate);
      } finally {
        releaseBranch?.();
        finishTransaction(projectId, state);
      }
    },

    isProjectIdle: (projectId) => !projects.has(projectId),

    whenProjectIdle: (projectId) => {
      const state = projects.get(projectId);
      if (state === undefined || state.transactions === 0) return Promise.resolve();
      return new Promise<void>((resolve) => state.idleWaiters.push(resolve));
    },

    isIdle: () => transactions === 0,

    whenIdle: () => {
      if (transactions === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}

function rejectAbortedWaiter(waiter: PermitWaiter): void {
  try {
    waiter.signal.throwIfAborted();
  } catch (error) {
    waiter.reject(error);
  }
}
