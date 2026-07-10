import { type ChildProcess, spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SafeError } from "@station/contracts";
import {
  createStationHostClient,
  type StationHostClient,
  stationHostSafeError,
} from "@station/host";
import { isSocketStale, removeStaleSocket } from "@station/protocol";
import { runRuntimeBoundaryWithRetryAndTimeout, safeErrorFromUnknown } from "@station/runtime";

export type StationHostHandle =
  | { status: "running"; socketPath: string; client: StationHostClient }
  | { status: "unavailable"; socketPath: string; error: SafeError };

/**
 * An executable plus its fixed entry prefix; the host layer appends socket and
 * state flags.
 */
export type StationHostCommand = readonly [command: string, ...prefixArgs: string[]];

export type SpawnStationHostInput = {
  argv: StationHostCommand;
  spawnOptions: { detached: true; stdio: "ignore" };
};

export type ChildProcessLike = Pick<ChildProcess, "pid" | "unref"> & {
  kill?: ChildProcess["kill"];
};

export type EnsureStationHostDeps = {
  clientFactory?: (socketPath: string) => StationHostClient;
  spawnHost?: (input: SpawnStationHostInput) => ChildProcessLike;
};

export type EnsureStationHostOptions = {
  socketPath: string;
  stateDir: string;
  hostCommand: StationHostCommand;
  timeoutMs?: number;
};

const defaultTimeoutMs = 10_000;

/**
 * Ensure the host by socket health, reaping stale sockets before detached spawn.
 * Failures degrade to `unavailable` so Station can fall back to UI-hosted PTYs.
 */
export async function ensureStationHostRunning(
  options: EnsureStationHostOptions,
  deps: EnsureStationHostDeps = {},
): Promise<StationHostHandle> {
  const { socketPath } = options;
  // A caller-supplied client is shared and long-lived (the provider reuses it), so
  // only a client WE created is disposed on a failure path.
  const ownsClient = deps.clientFactory === undefined;
  const client = (deps.clientFactory ?? defaultClientFactory)(socketPath);
  const disposeOwned = () => {
    if (ownsClient) {
      client.dispose();
    }
  };

  if (await socketExists(socketPath)) {
    if (await isSocketStale(socketPath)) {
      await removeStaleSocket(socketPath).catch(() => undefined);
    } else {
      try {
        await client.health();
        return { status: "running", socketPath, client };
      } catch {
        // Connectable but not a healthy station host (a wrong-build/hung process
        // owns the socket). Do not kill a process we did not spawn.
        disposeOwned();
        return {
          status: "unavailable",
          socketPath,
          error: stationHostSafeError(
            "HOST_UNREACHABLE",
            `A process owns ${socketPath} but did not answer a station-host health check.`,
            { hint: "Stop that process or use an isolated state dir." },
          ),
        };
      }
    }
  }

  if (options.hostCommand[0].length === 0) {
    disposeOwned();
    return {
      status: "unavailable",
      socketPath,
      error: stationHostSafeError("HOST_UNREACHABLE", "Station host command is not configured."),
    };
  }

  try {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    const child = (deps.spawnHost ?? defaultSpawnHost)({
      argv: [...options.hostCommand, "--socket", socketPath, "--state-dir", options.stateDir],
      spawnOptions: { detached: true, stdio: "ignore" },
    });
    child.unref?.();

    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const ready = await runRuntimeBoundaryWithRetryAndTimeout(
      {
        operation: "station.host.waitForHealth",
        timeoutMs,
        error: stationHostSafeError("HOST_UNREACHABLE", "Station host health check failed."),
        timeoutError: stationHostSafeError(
          "HOST_UNREACHABLE",
          "Station host did not become healthy before the timeout.",
        ),
        retry: { retries: Math.max(1, Math.ceil(timeoutMs / 50)), delayMs: 50 },
      },
      async () => client.health(),
    );

    if (!ready.ok) {
      child.kill?.();
      disposeOwned();
      return { status: "unavailable", socketPath, error: ready.error };
    }
    return { status: "running", socketPath, client };
  } catch (error) {
    disposeOwned();
    return {
      status: "unavailable",
      socketPath,
      error: safeErrorFromUnknown(
        error,
        stationHostSafeError("HOST_UNREACHABLE", "Could not start the station host."),
      ),
    };
  }
}

function defaultClientFactory(socketPath: string): StationHostClient {
  return createStationHostClient({ socketPath, timeoutMs: 1000 });
}

function defaultSpawnHost(input: SpawnStationHostInput): ChildProcessLike {
  // The HOST daemon is spawned detached+ignore (it owns the socket, not a pipe).
  // NB: the host in turn spawns the node-pty BRIDGE with piped stdio — never copy
  // this detached/ignore shape onto the bridge or its PTYs die at spawn.
  const [command, ...args] = input.argv;
  return spawn(command, args, input.spawnOptions);
}

async function socketExists(socketPath: string): Promise<boolean> {
  try {
    await lstat(socketPath);
    return true;
  } catch {
    return false;
  }
}
