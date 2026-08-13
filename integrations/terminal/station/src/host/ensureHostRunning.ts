import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostHandoffFidelity, PtyHandoffManifest, SafeError } from "@station/contracts";
import {
  assertHostReusable,
  classifyHostCompatibility,
  createStationHostClient,
  type HostHealthResult,
  isStationHostCompatibilityError,
  type StationHostClient,
  stationHostCompatibilityError,
  stationHostErrorFromUnknown,
  stationHostSafeError,
} from "@station/host";
import { probeUnixSocket, unixSocketHolderEvidencePath } from "@station/protocol";
import {
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  stationBuildInfo,
} from "@station/runtime";

export type StationHostEnsuredBy = "reuse" | "start" | "idle-replace" | "handoff";

export type StationHostHandoffAdoptReport = {
  adopted: string[];
  failed: Array<{ ptyId: string; reason: string }>;
};

export type StationHostHandle =
  | {
      status: "running";
      socketPath: string;
      client: StationHostClient;
      /** How this ensure call obtained a usable host. */
      ensuredBy: StationHostEnsuredBy;
      /** Present only when ensuredBy is handoff; fail-closed (failed empty). */
      handoffAdopt?: StationHostHandoffAdoptReport;
    }
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
  /**
   * Opt-in busy-host live handoff. Absent means today's visible refuse when the
   * incumbent has live PTYs.
   */
  handoff?: {
    fidelity: HostHandoffFidelity;
  };
};

const defaultTimeoutMs = 10_000;

type IncumbentHostDecision =
  | { outcome: "start"; ensuredBy: "start" | "idle-replace" }
  | {
      outcome: "start-with-handoff";
      manifest: PtyHandoffManifest;
    }
  | { outcome: "running" }
  | { outcome: "unavailable"; error: SafeError };

/**
 * ADAPTER
 *
 * Preserves inaccessible Host ownership and defers definite stale reclaim to
 * the child binder while retaining compatibility-aware idle replacement and an
 * opt-in busy-host live handoff path. Pre-commit failure restores the incumbent
 * refusal; after completion commits, parked PTYs remain available to a successor.
 */
export async function ensureStationHostRunning(
  options: EnsureStationHostOptions,
  deps: EnsureStationHostDeps = {},
): Promise<StationHostHandle> {
  const { socketPath } = options;
  const expectedBuildVersion = options.expectedBuildVersion ?? stationBuildInfo().version;
  const probe = await probeUnixSocket(socketPath);
  if (probe.status === "inaccessible") {
    return {
      status: "unavailable",
      socketPath,
      error: inaccessibleHostSocketError(socketPath),
    };
  }
  // A caller-supplied client is shared and long-lived (the provider reuses it), so
  // only a client WE created is disposed on a failure path.
  const ownsClient = deps.clientFactory === undefined;
  const client = (deps.clientFactory ?? defaultClientFactory)(socketPath, expectedBuildVersion);
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
          replacementConfigured: options.hostCommand[0].length > 0,
          timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
          client,
          ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
        });
  if (incumbent.outcome === "running") {
    return { status: "running", socketPath, client, ensuredBy: "reuse" };
  }
  if (incumbent.outcome === "unavailable") {
    disposeOwned();
    return { status: "unavailable", socketPath, error: incumbent.error };
  }
  const handoffManifest =
    incumbent.outcome === "start-with-handoff" ? incumbent.manifest : undefined;
  const ensuredBy =
    incumbent.outcome === "start-with-handoff" ? ("handoff" as const) : incumbent.ensuredBy;

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
    if (handoffManifest !== undefined) {
      const adopted = await adoptHandoffManifest(client, handoffManifest);
      if (!adopted.ok) {
        disposeOwned();
        return { status: "unavailable", socketPath, error: adopted.error };
      }
      return {
        status: "running",
        socketPath,
        client,
        ensuredBy: "handoff",
        handoffAdopt: adopted.report,
      };
    }
    return { status: "running", socketPath, client, ensuredBy };
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
  handoff?: { fidelity: HostHandoffFidelity };
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
    // stopIfIdle makes the empty check and draining transition atomic; spawn
    // waits for release so no connectable incumbent is ever unlinked.
    await input.client.stopIfIdle(input.expectedBuildVersion);
    await waitForSocketRelease(input.socketPath, input.timeoutMs);
    return { outcome: "start", ensuredBy: "idle-replace" };
  } catch (error) {
    if (isUpgradeBlocked(error) && input.handoff !== undefined) {
      return tryLiveHandoff({
        client: input.client,
        expectedBuildVersion: input.expectedBuildVersion,
        fidelity: input.handoff.fidelity,
        socketPath: input.socketPath,
        timeoutMs: input.timeoutMs,
        refusal: error,
      });
    }
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

async function tryLiveHandoff(input: {
  client: StationHostClient;
  expectedBuildVersion: string;
  fidelity: HostHandoffFidelity;
  socketPath: string;
  timeoutMs: number;
  refusal: SafeError;
}): Promise<IncumbentHostDecision> {
  let begun: Awaited<ReturnType<StationHostClient["beginHandoff"]>>;
  try {
    begun = await input.client.beginHandoff(input.expectedBuildVersion, input.fidelity);
  } catch (error) {
    return {
      outcome: "unavailable",
      error: refusalWithHandoffEvidence(
        input.refusal,
        stationHostErrorFromUnknown(error, {
          code: "HOST_HANDOFF_INVALID_STATE",
          message: "Station host live handoff could not begin safely.",
        }),
      ),
    };
  }

  try {
    await input.client.completeHandoff();
  } catch (error) {
    const handoffFailure = stationHostErrorFromUnknown(error, {
      code: "HOST_UNREACHABLE",
      message: "Station host live handoff could not be completed safely.",
    });
    try {
      const abort = await input.client.abortHandoff();
      if (restoredEveryManifestEntry(abort, begun.manifest)) {
        return {
          outcome: "unavailable",
          error: refusalWithHandoffEvidence(input.refusal, handoffFailure),
        };
      }
      return {
        outcome: "unavailable",
        error: parkedHandoffFailure(
          handoffFailure,
          stationHostSafeError(
            "HOST_HANDOFF_MANIFEST_INVALID",
            "Incumbent Host restoration did not recover every parked terminal.",
          ),
        ),
      };
    } catch (abortError) {
      return {
        outcome: "unavailable",
        error: parkedHandoffFailure(
          handoffFailure,
          stationHostErrorFromUnknown(abortError, {
            code: "HOST_HANDOFF_INVALID_STATE",
            message: "Incumbent Host restoration could not be confirmed.",
          }),
        ),
      };
    }
  }

  try {
    await waitForSocketRelease(input.socketPath, input.timeoutMs);
    return { outcome: "start-with-handoff", manifest: begun.manifest };
  } catch (error) {
    return {
      outcome: "unavailable",
      error: parkedHandoffFailure(
        stationHostErrorFromUnknown(error, {
          code: "HOST_UNREACHABLE",
          message: "Completed Station host handoff did not release the incumbent socket.",
        }),
      ),
    };
  }
}

function restoredEveryManifestEntry(
  report: { adopted: readonly string[]; failed: readonly { ptyId: string }[] },
  manifest: PtyHandoffManifest,
): boolean {
  if (report.failed.length > 0) return false;
  const expected = Object.keys(manifest).sort();
  return (
    report.adopted.length === expected.length &&
    [...report.adopted].sort().every((ptyId, index) => ptyId === expected[index])
  );
}

function refusalWithHandoffEvidence(refusal: SafeError, failure: SafeError): SafeError {
  const evidence = `Handoff failed: ${failure.message} (${failure.code}).`;
  return {
    ...refusal,
    hint: refusal.hint === undefined ? evidence : `${refusal.hint} ${evidence}`,
  };
}

function parkedHandoffFailure(failure: SafeError, restorationFailure?: SafeError): SafeError {
  const evidence =
    restorationFailure === undefined
      ? undefined
      : `Incumbent restoration was not confirmed: ${restorationFailure.message} (${restorationFailure.code}).`;
  const guidance = "Parked bridges remain under the state dir for successor recovery.";
  return {
    ...failure,
    hint: [evidence, guidance].filter((part) => part !== undefined).join(" "),
  };
}

export async function adoptHandoffManifest(
  client: StationHostClient,
  manifest: PtyHandoffManifest,
): Promise<{ ok: true; report: StationHostHandoffAdoptReport } | { ok: false; error: SafeError }> {
  try {
    const report = await client.adoptRegistry(manifest);
    const expected = Object.keys(manifest);
    if (report.failed.length > 0 || report.adopted.length !== expected.length) {
      return {
        ok: false,
        error: stationHostSafeError(
          "HOST_HANDOFF_MANIFEST_INVALID",
          "Successor host could not adopt every parked terminal from the handoff manifest.",
          {
            hint: "Parked bridges remain under the state dir until TTL reap or a retry.",
          },
        ),
      };
    }
    return { ok: true, report: { adopted: report.adopted, failed: report.failed } };
  } catch (error) {
    return {
      ok: false,
      error: stationHostErrorFromUnknown(error, {
        code: "HOST_HANDOFF_MANIFEST_INVALID",
        message: "Successor host could not adopt the handoff manifest.",
        hint: "Parked bridges remain under the state dir until TTL reap or a retry.",
      }),
    };
  }
}

function isUpgradeBlocked(error: unknown): error is SafeError {
  return isStationHostCompatibilityError(error) && error.code === "HOST_UPGRADE_BLOCKED";
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

function defaultSpawnHost(input: SpawnStationHostInput): ChildProcessLike {
  // The Host normally detaches; disposable runtime owners keep it in their process group for cleanup.
  // NB: the host in turn spawns the node-pty BRIDGE with piped stdio — never copy
  // this detached/ignore shape onto the bridge or its PTYs die at spawn.
  const [command, ...args] = input.argv;
  return spawn(command, args, {
    ...input.spawnOptions,
    detached: process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1",
  });
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
