export type WorktreeRegistryMutationCoordinator = {
  runCreate<T>(
    projectId: string,
    attempt: () => Promise<T>,
    shouldRecover: (error: unknown) => boolean,
    recover: (error: unknown) => Promise<T>,
  ): Promise<T>;
  runExclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T>;
};

type ExclusiveRequest = {
  run(): Promise<void>;
};

type ProjectMutationState = {
  activeCreates: number;
  runningExclusive: boolean;
  exclusiveQueue: ExclusiveRequest[];
  createWaiters: Array<() => void>;
};

/**
 * Coordinates Worktrunk operations around Git's non-atomic worktree registry. Normal creates keep
 * their measured overlap. Reads, removals, and recovery of a proven half-created branch close new
 * create admission and drain older creates so they observe a settled registry.
 */
export function createWorktreeRegistryMutationCoordinator(): WorktreeRegistryMutationCoordinator {
  const projects = new Map<string, ProjectMutationState>();

  const stateFor = (projectId: string): ProjectMutationState => {
    const existing = projects.get(projectId);
    if (existing !== undefined) return existing;
    const state: ProjectMutationState = {
      activeCreates: 0,
      runningExclusive: false,
      exclusiveQueue: [],
      createWaiters: [],
    };
    projects.set(projectId, state);
    return state;
  };

  const finishIfIdle = (projectId: string, state: ProjectMutationState): void => {
    if (
      state.activeCreates === 0 &&
      !state.runningExclusive &&
      state.exclusiveQueue.length === 0 &&
      state.createWaiters.length === 0
    ) {
      projects.delete(projectId);
    }
  };

  const admitCreates = (state: ProjectMutationState): void => {
    if (state.runningExclusive || state.exclusiveQueue.length > 0) return;
    const waiters = state.createWaiters.splice(0);
    // Reserve each admission before resolving it so a new caller cannot observe a false idle gap.
    state.activeCreates += waiters.length;
    for (const resolve of waiters) resolve();
  };

  const drainExclusive = (projectId: string, state: ProjectMutationState): void => {
    if (state.runningExclusive || state.activeCreates > 0 || state.exclusiveQueue.length === 0) {
      return;
    }
    state.runningExclusive = true;
    void (async () => {
      while (state.exclusiveQueue.length > 0) {
        const request = state.exclusiveQueue.shift();
        if (request !== undefined) await request.run();
      }
      state.runningExclusive = false;
      admitCreates(state);
      finishIfIdle(projectId, state);
    })();
  };

  const acquireCreate = (state: ProjectMutationState): Promise<void> => {
    if (!state.runningExclusive && state.exclusiveQueue.length === 0) {
      state.activeCreates += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => state.createWaiters.push(resolve));
  };

  const queueExclusive = <T>(
    projectId: string,
    state: ProjectMutationState,
    operation: () => Promise<T>,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      state.exclusiveQueue.push({
        run: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        },
      });
      drainExclusive(projectId, state);
    });

  return {
    async runCreate<T>(
      projectId: string,
      attempt: () => Promise<T>,
      shouldRecover: (error: unknown) => boolean,
      recover: (error: unknown) => Promise<T>,
    ): Promise<T> {
      const state = stateFor(projectId);
      await acquireCreate(state);
      let recovery: Promise<T> | undefined;
      try {
        return await attempt();
      } catch (error) {
        if (!shouldRecover(error)) throw error;
        // Queue before releasing this attempt; this closes admission without an observable gap.
        recovery = queueExclusive(projectId, state, () => recover(error));
      } finally {
        state.activeCreates -= 1;
        drainExclusive(projectId, state);
        finishIfIdle(projectId, state);
      }
      return recovery;
    },

    runExclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
      const state = stateFor(projectId);
      return queueExclusive(projectId, state, operation);
    },
  };
}
