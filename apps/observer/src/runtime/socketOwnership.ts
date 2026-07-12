import { lstat } from "node:fs/promises";

export type SocketOwnershipWatch = {
  stop(): void;
};

export type WatchSocketOwnershipOptions = {
  socketPath: string;
  intervalMs?: number;
  /**
   * The identity of the socket this process just bound. Seeding it means the
   * watcher knows what it owns from the first tick, so a takeover that happened
   * before the watch was armed is detected instead of being adopted as the
   * baseline. Omit to baseline from the first probe (legacy behavior).
   */
  expectedIdentity?: SocketIdentity;
  onLost(): void;
};

// A legacy or otherwise uncoordinated observer can claim the socket path by
// unlinking and rebinding it, which gives the displaced process no signal.
// Watching the file's inode is the only way it can learn it lost ownership and
// must shut down instead of lingering.
// Inode number alone is ambiguous: a recreated path can reuse the just-freed
// inode (ext4 does this routinely), so identity pairs it with the birth time.
// Filesystems without btime report 0n for both files, degrading to inode-only.
export type SocketIdentity = { ino: bigint; birthtimeNs: bigint };

/** Reads the current identity of a bound socket, for seeding the watcher. */
export async function readSocketIdentity(socketPath: string): Promise<SocketIdentity | undefined> {
  try {
    const stats = await lstat(socketPath, { bigint: true });
    return { ino: stats.ino, birthtimeNs: stats.birthtimeNs };
  } catch {
    return undefined;
  }
}

export function watchSocketOwnership(options: WatchSocketOwnershipOptions): SocketOwnershipWatch {
  const intervalMs = options.intervalMs ?? 5000;
  let owned: SocketIdentity | undefined = options.expectedIdentity;
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
    let current: SocketIdentity | undefined;
    try {
      const stats = await lstat(options.socketPath, { bigint: true });
      current = { ino: stats.ino, birthtimeNs: stats.birthtimeNs };
    } catch {
      current = undefined;
    }
    if (owned === undefined) {
      owned = current;
      return;
    }
    if (current?.ino !== owned.ino || current?.birthtimeNs !== owned.birthtimeNs) {
      lose();
    }
  };

  const interval = setInterval(() => {
    void probe();
  }, intervalMs);
  interval.unref();
  void probe();

  return {
    // Mark fired so a probe already in flight cannot report a takeover
    // after a normal shutdown unlinks the socket.
    stop: () => {
      fired = true;
      clearInterval(interval);
    },
  };
}
