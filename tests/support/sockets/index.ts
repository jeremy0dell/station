import { spawn } from "node:child_process";
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

export async function createRealStaleSocket(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import { createServer } from "node:net";',
        "const server = createServer();",
        'server.listen(process.argv[1], () => process.stdout.write("ready\\n"));',
      ].join(""),
      socketPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForChildReady(child, socketPath);
    child.kill("SIGKILL");
    await waitForChildExit(child);
    const socket = await lstat(socketPath);
    if (!socket.isSocket()) {
      throw new Error(`Killed socket owner did not leave an AF_UNIX pathname: ${socketPath}`);
    }
  } catch (error) {
    child.kill("SIGKILL");
    await waitForChildExit(child).catch(() => undefined);
    throw error;
  }
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

function waitForChildReady(child: ReturnType<typeof spawn>, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out creating stale socket: ${socketPath}`));
    }, 2000);
    let stderr = "";
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onStdout = (chunk: Buffer) => {
      if (!chunk.toString("utf8").includes("ready")) return;
      cleanup();
      resolve();
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Socket owner exited before listening (${signal ?? `exit ${String(code)}`}): ${stderr}`,
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}
