import { type ChildProcess, spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SafeError } from "@station/contracts";
import {
  assertHostReusable,
  classifyHostCompatibility,
  createStationHostClient,
  type HostHealthResult,
  isStationHostCompatibilityError,
  type StationHostClient,
  stationHostCompatibilityError,
  stationHostSafeError,
} from "@station/host";
import { isSocketStale, removeStaleSocket } from "@station/protocol";
import {
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  stationBuildInfo,
} from "@station/runtime";

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
  clientFactory?: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
  spawnHost?: (input: SpawnStationHostInput) => ChildProcessLike;
};

export type EnsureStationHostOptions = {
  socketPath: string;
  stateDir: string;
  hostCommand: StationHostCommand;
  /** Expected opaque Station build version; defaults to this process's build. */
  expectedBuildVersion?: string;
  timeoutMs?: number;
};

const defaultTimeoutMs = 10_000;

type IncumbentHostDecision =
  | { outcome: "start" }
  | { outcome: "running" }
  | { outcome: "unavailable"; error: SafeError };

/**
 * Ensure the host by socket health, reaping stale sockets before detached spawn.
 * Compatibility failures remain `unavailable` preservation errors for callers to surface.
 */
export async function ensureStationHostRunning(
  options: EnsureStationHostOptions,
  deps: EnsureStationHostDeps = {},
): Promise<StationHostHandle> {
  const { socketPath } = options;
  const expectedBuildVersion = options.expectedBuildVersion ?? stationBuildInfo().version;
  // A caller-supplied client is shared and long-lived (the provider reuses it), so
  // only a client WE created is disposed on a failure path.
  const ownsClient = deps.clientFactory === undefined;
  const client = (deps.clientFactory ?? defaultClientFactory)(socketPath, expectedBuildVersion);
  const disposeOwned = () => {
    if (ownsClient) {
      client.dispose();
    }
  };

  const incumbent = await negotiateIncumbentHost({
    socketPath,
    expectedBuildVersion,
    replacementConfigured: options.hostCommand[0].length > 0,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    client,
  });
  if (incumbent.outcome === "running") {
    return { status: "running", socketPath, client };
  }
  if (incumbent.outcome === "unavailable") {
    disposeOwned();
    return { status: "unavailable", socketPath, error: incumbent.error };
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
        retry: {
          retries: Math.max(1, Math.ceil(timeoutMs / 50)),
          delayMs: 50,
          shouldRetry: (error) => !isStationHostCompatibilityError(error),
        },
      },
      async () => {
        const health = await client.health();
        assertHostReusable(health, expectedBuildVersion);
        return health;
      },
    );

    if (!ready.ok) {
      if (!isStationHostCompatibilityError(ready.error)) {
        child.kill?.();
      }
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

async function negotiateIncumbentHost(input: {
  socketPath: string;
  expectedBuildVersion: string;
  replacementConfigured: boolean;
  timeoutMs: number;
  client: StationHostClient;
}): Promise<IncumbentHostDecision> {
  if (!(await socketExists(input.socketPath))) {
    return { outcome: "start" };
  }
  if (await isSocketStale(input.socketPath)) {
    await removeStaleSocket(input.socketPath).catch(() => undefined);
    return { outcome: "start" };
  }

  let health: HostHealthResult;
  try {
    health = await input.client.health();
  } catch {
    return {
      outcome: "unavailable",
      error: stationHostSafeError(
        "HOST_UNREACHABLE",
        `A process owns ${input.socketPath} but did not answer a station-host health check.`,
        {
          hint: "Inspect it with the matching Station build, or use an isolated state dir; do not stop it until its terminals are accounted for.",
        },
      ),
    };
  }

  const compatibility = classifyHostCompatibility(health, input.expectedBuildVersion);
  if (compatibility.action === "reuse") {
    return { outcome: "running" };
  }
  const compatibilityError =
    stationHostCompatibilityError(health, input.expectedBuildVersion) ??
    stationHostSafeError(
      "HOST_VERSION_INCOMPATIBLE",
      "Station host compatibility could not be determined safely.",
    );
  if (compatibility.action === "refuse" || !input.replacementConfigured) {
    return { outcome: "unavailable", error: compatibilityError };
  }

  try {
    // stopIfIdle makes the empty check and draining transition atomic; spawn
    // waits for release so no connectable incumbent is ever unlinked.
    await input.client.stopIfIdle(input.expectedBuildVersion);
    await waitForSocketRelease(input.socketPath, input.timeoutMs);
    if (await socketExists(input.socketPath)) {
      await removeStaleSocket(input.socketPath);
    }
    return { outcome: "start" };
  } catch (error) {
    return {
      outcome: "unavailable",
      error: isStationHostCompatibilityError(error)
        ? error
        : stationHostSafeError(
            "HOST_VERSION_INCOMPATIBLE",
            "Station host upgrade could not be completed safely.",
            {
              hint: "The existing host and terminals were preserved. Retry, or reopen with the running build.",
            },
          ),
    };
  }
}

function defaultClientFactory(socketPath: string, expectedBuildVersion: string): StationHostClient {
  return createStationHostClient({ socketPath, expectedBuildVersion, timeoutMs: 1000 });
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

async function waitForSocketRelease(socketPath: string, timeoutMs: number): Promise<void> {
  const released = await runRuntimeBoundaryWithRetryAndTimeout(
    {
      operation: "station.host.waitForSocketRelease",
      timeoutMs,
      error: stationHostSafeError(
        "HOST_UNREACHABLE",
        "Station host socket is still accepting connections after idle shutdown.",
      ),
      retry: { retries: Math.max(1, Math.ceil(timeoutMs / 50)), delayMs: 50 },
    },
    async () => {
      if ((await socketExists(socketPath)) && !(await isSocketStale(socketPath))) {
        throw stationHostSafeError(
          "HOST_UNREACHABLE",
          "Station host socket is still accepting connections after idle shutdown.",
        );
      }
    },
  );
  if (!released.ok) {
    throw released.error;
  }
}
