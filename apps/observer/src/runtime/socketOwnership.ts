import { lstat } from "node:fs/promises";

export type SocketOwnershipWatch = {
  stop(): void;
};

export type WatchSocketOwnershipOptions = {
  socketPath: string;
  intervalMs?: number;
  onLost(): void;
};

// A newer observer claims the socket path by unlinking and rebinding it, which
// gives the displaced process no signal. Watching the file's inode is the only
// way it can learn it lost ownership and must shut down instead of lingering.
export function watchSocketOwnership(options: WatchSocketOwnershipOptions): SocketOwnershipWatch {
  const intervalMs = options.intervalMs ?? 5000;
  let ownedInode: bigint | undefined;
  let fired = false;

  const lose = () => {
    if (fired) {
      return;
    }
    fired = true;
    clearInterval(interval);
    options.onLost();
  };

  const probe = async () => {
    let currentInode: bigint | undefined;
    try {
      currentInode = (await lstat(options.socketPath, { bigint: true })).ino;
    } catch {
      currentInode = undefined;
    }
    if (ownedInode === undefined) {
      ownedInode = currentInode;
      return;
    }
    if (currentInode !== ownedInode) {
      lose();
    }
  };

  const interval = setInterval(() => {
    void probe();
  }, intervalMs);
  interval.unref();
  void probe();

  return {
    stop: () => clearInterval(interval),
  };
}
