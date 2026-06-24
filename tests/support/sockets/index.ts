import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function createTempSocketPath(prefix = "station-protocol-"): Promise<{
  dir: string;
  socketPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    socketPath: join(dir, "observer.sock"),
  };
}

export async function createStaleSocketFile(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true });
  await writeFile(socketPath, "stale", { mode: 0o600 });
}

export async function waitForSocketClosed(
  socketPath: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (!(await socketAcceptsConnections(socketPath))) {
      return;
    }
    await sleep(intervalMs);
  }

  throw new Error(`Socket did not close before timeout: ${socketPath}`);
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  try {
    const stats = await lstat(socketPath);
    if (!stats.isSocket()) {
      return false;
    }
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 50);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
