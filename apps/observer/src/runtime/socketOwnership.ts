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
// Inode number alone is ambiguous: a recreated path can reuse the just-freed
// inode (ext4 does this routinely), so identity pairs it with the birth time.
// Filesystems without btime report 0n for both files, degrading to inode-only.
type SocketIdentity = { ino: bigint; birthtimeNs: bigint };

export function watchSocketOwnership(options: WatchSocketOwnershipOptions): SocketOwnershipWatch {
  const intervalMs = options.intervalMs ?? 5000;
  let owned: SocketIdentity | undefined;
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
