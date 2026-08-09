export type WorktreeMutationCoordinator = {
  run<T>(projectId: string, worktreeId: string, mutation: () => Promise<T>): Promise<T>;
};

/** Serializes lifecycle mutations for one configured worktree without blocking unrelated worktrees. */
export function createWorktreeMutationCoordinator(): WorktreeMutationCoordinator {
  const chains = new Map<string, Promise<void>>();
  return {
    async run<T>(projectId: string, worktreeId: string, mutation: () => Promise<T>): Promise<T> {
      const key = `${projectId}\0${worktreeId}`;
      const previous = chains.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      chains.set(key, tail);
      await previous;
      try {
        return await mutation();
      } finally {
        release();
        if (chains.get(key) === tail) {
          chains.delete(key);
        }
      }
    },
  };
}
