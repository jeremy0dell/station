import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SafeError } from "@station/contracts";
import {
  classifyHostCompatibility,
  createStationHostClient,
  type HostHealthResult,
  isStationHostCompatibilityError,
  type StationHostClient,
  stationHostCompatibilityError,
  stationHostSafeError,
} from "@station/host";
import { probeUnixSocket, unixSocketHolderEvidencePath } from "@station/protocol";
import {
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  stationBuildInfo,
} from "@station/runtime";
import {
  type CausalStationHostEvidencePorts,
  startCausalStationHost,
} from "./readStationHostEvidence.js";

export type StationHostEnsuredBy = "reuse" | "start" | "idle-replace";

export type StationHostHandle =
  | {
      status: "running";
      socketPath: string;
      client: StationHostClient;
      /** How this ensure call obtained a usable host. */
      ensuredBy: StationHostEnsuredBy;
    }
  | { status: "unavailable"; socketPath: string; error: SafeError };

/**
 * An executable plus its fixed entry prefix; the host layer appends socket and
 * state flags.
 */
export type StationHostCommand = readonly [command: string, ...prefixArgs: string[]];

export type SpawnStationHostInput = {
  argv: StationHostCommand;
  /**
   * `unref()` releases the caller's event-loop reference; `detached` separately
   * controls whether the Host leaves the physical process group.
   */
  spawnOptions: { detached: boolean; stdio: "ignore" };
};

/** Exact events, PID, and signals required until direct-child transfer or cleanup settles. */
export type ChildProcessLike = Pick<ChildProcess, "kill" | "off" | "on" | "pid" | "unref">;

export type EnsureStationHostDeps = {
  clientFactory?: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
  spawnHost?: (input: SpawnStationHostInput) => ChildProcessLike;
  readiness?: Partial<CausalStationHostEvidencePorts>;
  now?: () => number;
};

export type EnsureStationHostOptions = {
  socketPath: string;
  stateDir: string;
  hostCommand: StationHostCommand;
  /** Expected display build; immutable build identity is intentionally out of scope. */
  expectedBuildVersion?: string;
  /** `startupCutoff = start + timeoutMs`; `D = startupCutoff + 2,000`. */
  timeoutMs?: number;
};

const defaultTimeoutMs = 10_000;
type IncumbentHostDecision =
  | { outcome: "start"; ensuredBy: "start" | "idle-replace" }
  | { outcome: "running" }
  | { outcome: "unavailable"; error: SafeError };

/**
 * ADAPTER
 *
 * Preserves inaccessible ownership and provides compatibility-only absent/stale start, current
 * protocol and display-version reuse, atomic idle replacement, and busy refusal.
 */
export async function ensureStationHostRunning(
  options: EnsureStationHostOptions,
  deps: EnsureStationHostDeps = {},
): Promise<StationHostHandle> {
  const { clientFactory = defaultClientFactory, now = Date.now, readiness, spawnHost } = deps;
  const readinessSnapshot = readiness === undefined ? undefined : { ...readiness };
  const ownsClient = deps.clientFactory === undefined;
  const startedAt = now();
  const socketPath = options.socketPath;
  const stateDir = options.stateDir;
  const hostCommand = [...options.hostCommand] as StationHostCommand;
  const expectedBuildVersion = options.expectedBuildVersion ?? stationBuildInfo().version;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const startupCutoff = startedAt + timeoutMs;
  const deadline = startupCutoff + 2_000;
  const detached = process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1";
  const probe = await probeUnixSocket(socketPath);
  if (probe.status === "inaccessible") {
    return {
      status: "unavailable",
      socketPath,
      error: inaccessibleHostSocketError(socketPath),
    };
  }
  const client = clientFactory(socketPath, expectedBuildVersion);
  const disposeOwned = () => {
    if (ownsClient) {
      client.dispose();
    }
  };
  const incumbent =
    probe.status === "absent" || probe.status === "stale"
      ? ({ outcome: "start", ensuredBy: "start" } as const)
      : await negotiateIncumbentHost({
          socketPath,
          expectedBuildVersion,
          replacementConfigured: hostCommand[0].length > 0,
          timeoutMs: Math.max(1, startupCutoff - now()),
          client,
        });
  if (incumbent.outcome === "running") {
    return { status: "running", socketPath, client, ensuredBy: "reuse" };
  }
  if (incumbent.outcome === "unavailable") {
    disposeOwned();
    return { status: "unavailable", socketPath, error: incumbent.error };
  }
  if (hostCommand[0].length === 0) {
    disposeOwned();
    return {
      status: "unavailable",
      socketPath,
      error: stationHostSafeError("HOST_UNREACHABLE", "Station host command is not configured."),
    };
  }

  try {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    const started = await startCausalStationHost(
      {
        socketPath,
        stateDir,
        hostCommand,
        detached,
        expectedBuildVersion,
        startupCutoffMs: startupCutoff,
        deadlineMs: deadline,
      },
      {
        ...readinessSnapshot,
        ...(spawnHost === undefined ? {} : { spawnHost }),
        now,
      },
    );
    if (started.status === "failed")
      throw started.childDisposition !== "unproven"
        ? started.error
        : stationHostSafeError("HOST_UNREACHABLE", "Spawned Station Host did not settle safely.");
    started.session.dispose();
    return { status: "running", socketPath, client, ensuredBy: incumbent.ensuredBy };
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
    await input.client.stopIfIdle(input.expectedBuildVersion);
    await waitForSocketRelease(input.socketPath, input.timeoutMs);
    return { outcome: "start", ensuredBy: "idle-replace" };
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

function inaccessibleHostSocketError(socketPath: string): SafeError {
  const evidencePath = unixSocketHolderEvidencePath();
  return stationHostSafeError(
    "HOST_UNREACHABLE",
    `The Station Host socket exists at ${socketPath} but cannot be reached or proven safe to reclaim.`,
    {
      hint: `Restore access, normally mode 0600. Station will not reclaim the socket without holder evidence from ${evidencePath}; install lsof if that executable is missing; do not unlink it or start a competing Host while ownership is uncertain.`,
    },
  );
}

function defaultClientFactory(socketPath: string, expectedBuildVersion: string): StationHostClient {
  return createStationHostClient({ socketPath, expectedBuildVersion, timeoutMs: 1000 });
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
      const probe = await probeUnixSocket(socketPath);
      if (probe.status === "listening" || probe.status === "inaccessible") {
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
