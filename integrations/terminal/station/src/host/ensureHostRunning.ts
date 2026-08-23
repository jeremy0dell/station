import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  compareCodeUnitStrings,
  comparePtyLifetimeIdentities,
  type HostHandoffFidelity,
  type PtyHandoffManifest,
  type PtyHandoffReceipt,
  PtyHandoffReceiptSchema,
  type PtyLifetimeIdentity,
  ptyLifetimeIdentitySetsMatch,
  type SafeError,
  type UpdateHostConvergenceCommand,
  type UpdateHostConvergenceCommitment,
} from "@station/contracts";
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
  isSafeError,
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  stationBuildInfo,
} from "@station/runtime";

export type StationHostEnsuredBy = "reuse" | "start" | "idle-replace" | "handoff";

export type StationHostHandoffAdoptReport = {
  adopted: string[];
  failed: Array<{ ptyId: string; reason: string }>;
  receipt: PtyHandoffReceipt;
};

export type StationHostHandle =
  | {
      status: "running";
      socketPath: string;
      client: StationHostClient;
      /** How this ensure call obtained a usable host. */
      ensuredBy: StationHostEnsuredBy;
      /** Present only for handoff; its receipt names every immutable adopted PTY lifetime. */
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
  /**
   * `unref()` releases the caller's event-loop reference; `detached` separately
   * controls whether the Host leaves the physical process group.
   */
  spawnOptions: { detached: boolean; stdio: "ignore" };
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
  /** Optional immutable content identity for exact same-version convergence admission. */
  expectedBuildIdentity?: string;
  timeoutMs?: number;
  /**
   * Opt-in busy-host live handoff. Absent means today's visible refuse when the
   * incumbent has live PTYs.
   */
  handoff?: {
    fidelity: HostHandoffFidelity;
  };
};

export type ConvergeStationHostForUpdateOptions = Omit<
  EnsureStationHostOptions,
  "expectedBuildIdentity" | "expectedBuildVersion" | "handoff"
> & {
  command: UpdateHostConvergenceCommand;
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
 * refusal; after completion commits, parked PTYs remain available to a successor. Adoption succeeds
 * only with an exact PTY-id set and returns a canonical immutable-lifetime receipt.
 */
export async function ensureStationHostRunning(
  options: EnsureStationHostOptions,
  deps: EnsureStationHostDeps = {},
): Promise<StationHostHandle> {
  return ensureStationHostRunningInternal(options, deps);
}

/**
 * ADAPTER
 *
 * Executes one update-authorized Host action only while the exact committed incumbent build and
 * immutable PTY inventory remain current; it never switches between idle replacement and handoff.
 */
export async function convergeStationHostForUpdate(
  options: ConvergeStationHostForUpdateOptions,
  deps: EnsureStationHostDeps = {},
): Promise<StationHostHandle> {
  const target = options.command.commitment.target;
  const handle = await ensureStationHostRunningInternal(
    {
      socketPath: options.socketPath,
      stateDir: options.stateDir,
      hostCommand: options.hostCommand,
      expectedBuildVersion: target.buildVersion,
      expectedBuildIdentity: target.buildIdentity,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    deps,
    options.command,
  );
  if (handle.status !== "running") return handle;
  const expectedEnsuredBy = options.command.action === "replace-idle" ? "idle-replace" : "handoff";
  if (handle.ensuredBy === expectedEnsuredBy) return handle;
  handle.client.dispose();
  return {
    status: "unavailable",
    socketPath: options.socketPath,
    error: stationHostSafeError(
      "HOST_CONVERGENCE_PLAN_DRIFT",
      "Station Host convergence completed through an action the authorized plan did not permit.",
    ),
  };
}

async function ensureStationHostRunningInternal(
  options: EnsureStationHostOptions,
  deps: EnsureStationHostDeps,
  convergence?: UpdateHostConvergenceCommand,
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
      ? convergence === undefined
        ? ({ outcome: "start", ensuredBy: "start" } as const)
        : ({
            outcome: "unavailable",
            error: hostConvergencePlanDrift(
              "The planned incumbent Host is no longer listening at the committed socket.",
            ),
          } as const)
      : await negotiateIncumbentHost({
          socketPath,
          expectedBuildVersion,
          ...(options.expectedBuildIdentity === undefined
            ? {}
            : { expectedBuildIdentity: options.expectedBuildIdentity }),
          replacementConfigured: options.hostCommand[0].length > 0,
          timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
          client,
          ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
          ...(convergence === undefined ? {} : { convergence }),
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
    const detached = process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1";
    const child = (deps.spawnHost ?? defaultSpawnHost)({
      argv: [...options.hostCommand, "--socket", socketPath, "--state-dir", options.stateDir],
      spawnOptions: { detached, stdio: "ignore" },
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
        if (options.expectedBuildIdentity !== undefined) {
          const inventory = await client.recoveryInventory?.();
          if (inventory?.buildIdentity !== options.expectedBuildIdentity) {
            throw stationHostSafeError(
              "HOST_VERSION_INCOMPATIBLE",
              "Station host immutable build identity does not match the requesting build.",
            );
          }
        }
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
  expectedBuildIdentity?: string;
  replacementConfigured: boolean;
  timeoutMs: number;
  client: StationHostClient;
  handoff?: { fidelity: HostHandoffFidelity };
  convergence?: UpdateHostConvergenceCommand;
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

  if (input.convergence !== undefined) {
    const commitmentError = await validateHostConvergenceCommitment(
      input.client,
      health,
      input.convergence,
    );
    if (commitmentError !== undefined) {
      return { outcome: "unavailable", error: commitmentError };
    }
  }

  let compatibility = classifyHostCompatibility(health, input.expectedBuildVersion);
  if (compatibility.action === "reuse" && input.expectedBuildIdentity !== undefined) {
    try {
      const inventory = await input.client.recoveryInventory?.();
      if (inventory === undefined) {
        return {
          outcome: "unavailable",
          error: stationHostSafeError(
            "HOST_VERSION_INCOMPATIBLE",
            "Station host immutable build identity is unavailable.",
          ),
        };
      }
      if (inventory.buildIdentity !== input.expectedBuildIdentity) {
        compatibility = {
          action: "replace",
          runningBuildVersion: input.expectedBuildVersion,
        };
      }
    } catch (error) {
      return {
        outcome: "unavailable",
        error: stationHostErrorFromUnknown(error, {
          code: "HOST_VERSION_INCOMPATIBLE",
          message: "Station host immutable build identity could not be verified.",
        }),
      };
    }
  }
  if (compatibility.action === "reuse") {
    if (input.convergence !== undefined) {
      return {
        outcome: "unavailable",
        error: hostConvergencePlanDrift(
          "The incumbent Host already matches the selected build instead of the planned replacement state.",
        ),
      };
    }
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

  if (input.convergence?.action === "handoff") {
    return tryLiveHandoff({
      client: input.client,
      expectedBuildVersion: input.expectedBuildVersion,
      fidelity: input.convergence.fidelity,
      socketPath: input.socketPath,
      timeoutMs: input.timeoutMs,
      refusal: compatibilityError,
      expectedInventory: input.convergence.commitment.incumbent.inventory.terminals,
    });
  }

  try {
    // stopIfIdle makes the empty check and draining transition atomic; spawn
    // waits for release so no connectable incumbent is ever unlinked.
    await input.client.stopIfIdle(input.expectedBuildVersion);
    await waitForSocketRelease(input.socketPath, input.timeoutMs);
    return { outcome: "start", ensuredBy: "idle-replace" };
  } catch (error) {
    if (input.convergence?.action === "replace-idle" && isUpgradeBlocked(error)) {
      return {
        outcome: "unavailable",
        error: hostConvergencePlanDrift(
          "The Host acquired a live terminal after idle replacement was planned.",
        ),
      };
    }
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
  expectedInventory?: readonly PtyLifetimeIdentity[];
}): Promise<IncumbentHostDecision> {
  let begun: Awaited<ReturnType<StationHostClient["beginHandoff"]>>;
  try {
    begun = await input.client.beginHandoff(input.expectedBuildVersion, input.fidelity);
  } catch (error) {
    if (input.expectedInventory !== undefined) {
      return {
        outcome: "unavailable",
        error: hostConvergencePlanDrift(
          "The Host could not begin the exact live handoff authorized by the convergence plan.",
        ),
      };
    }
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

  if (input.expectedInventory !== undefined) {
    const begunInventory = ptyLifetimeIdentitiesFromManifest(begun.manifest);
    if (!ptyLifetimeIdentitySetsMatch(input.expectedInventory, begunInventory)) {
      try {
        const abort = await input.client.abortHandoff();
        if (restoredEveryManifestEntry(abort, begun.manifest)) {
          return {
            outcome: "unavailable",
            error: hostConvergencePlanDrift(
              "The Host immutable terminal inventory changed while live handoff was beginning.",
            ),
          };
        }
        return {
          outcome: "unavailable",
          error: parkedHandoffFailure(
            hostConvergencePlanDrift(
              "The Host immutable terminal inventory changed while live handoff was beginning.",
            ),
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
            hostConvergencePlanDrift(
              "The Host immutable terminal inventory changed while live handoff was beginning.",
            ),
            stationHostErrorFromUnknown(abortError, {
              code: "HOST_HANDOFF_INVALID_STATE",
              message: "Incumbent Host restoration could not be confirmed after inventory drift.",
            }),
          ),
        };
      }
    }
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

async function validateHostConvergenceCommitment(
  client: StationHostClient,
  health: HostHealthResult,
  command: UpdateHostConvergenceCommand,
): Promise<SafeError | undefined> {
  const expected = command.commitment.incumbent;
  if (
    health.protocolVersion !== expected.protocolVersion ||
    !committedValueMatches(expected.buildVersion, health.buildVersion)
  ) {
    return hostConvergencePlanDrift(
      "The incumbent Host build or protocol no longer matches the authorized convergence plan.",
    );
  }

  let actual: {
    buildIdentity: string | undefined;
    terminals: PtyLifetimeIdentity[];
  };
  try {
    actual = await readCommittedHostInventory(client);
  } catch {
    return hostConvergencePlanDrift(
      "The incumbent Host immutable inventory can no longer be verified against the convergence plan.",
    );
  }
  if (
    !committedValueMatches(expected.buildIdentity, actual.buildIdentity) ||
    !ptyLifetimeIdentitySetsMatch(expected.inventory.terminals, actual.terminals)
  ) {
    return hostConvergencePlanDrift(
      "The incumbent Host build or immutable terminal inventory changed after convergence planning.",
    );
  }
  return undefined;
}

async function readCommittedHostInventory(client: StationHostClient): Promise<{
  buildIdentity: string | undefined;
  terminals: PtyLifetimeIdentity[];
}> {
  const recoveryInventory = client.lifecycleRecoveryInventory ?? client.recoveryInventory;
  if (recoveryInventory !== undefined) {
    try {
      const inventory = await recoveryInventory();
      return {
        buildIdentity: inventory.buildIdentity,
        terminals: inventory.ptys
          .map(ptyLifetimeIdentityFromEntry)
          .sort(comparePtyLifetimeIdentities),
      };
    } catch (error) {
      if (!isSafeError(error) || error.code !== "HOST_BAD_REQUEST") throw error;
    }
  }
  const ptys = await (client.lifecycleList ?? client.list)();
  return {
    buildIdentity: undefined,
    terminals: ptys.map(ptyLifetimeIdentityFromEntry).sort(comparePtyLifetimeIdentities),
  };
}

function committedValueMatches(
  expected: UpdateHostConvergenceCommitment["incumbent"]["buildVersion"],
  actual: string | undefined,
): boolean {
  return expected.status === "known" ? actual === expected.value : actual === undefined;
}

function ptyLifetimeIdentityFromEntry(entry: {
  terminalTargetId: string;
  ptyId: string;
  ptyInstanceId: string;
}): PtyLifetimeIdentity {
  return {
    terminalTargetId: entry.terminalTargetId,
    ptyId: entry.ptyId,
    ptyInstanceId: entry.ptyInstanceId,
  };
}

function ptyLifetimeIdentitiesFromManifest(manifest: PtyHandoffManifest): PtyLifetimeIdentity[] {
  return Object.entries(manifest)
    .map(([ptyId, entry]) => ({
      terminalTargetId: entry.identity.terminalTargetId,
      ptyId,
      ptyInstanceId: entry.ptyInstanceId,
    }))
    .sort(comparePtyLifetimeIdentities);
}

function hostConvergencePlanDrift(message: string): SafeError {
  return stationHostSafeError("HOST_CONVERGENCE_PLAN_DRIFT", message, {
    hint: "No alternate Host convergence action was authorized; inspect live state and plan again.",
  });
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
    const expected = Object.keys(manifest).sort(compareCodeUnitStrings);
    const adopted = [...report.adopted].sort(compareCodeUnitStrings);
    const exactAdoptedSet =
      adopted.length === expected.length &&
      adopted.every((ptyId, index) => ptyId === expected[index]) &&
      adopted.every((ptyId, index) => index === 0 || ptyId !== adopted[index - 1]);
    if (report.failed.length > 0 || !exactAdoptedSet) {
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
    const terminals = expected
      .map((ptyId) => {
        const entry = manifest[ptyId];
        if (entry === undefined) throw new Error("Validated handoff manifest entry disappeared.");
        return {
          terminalTargetId: entry.identity.terminalTargetId,
          ptyId,
          ptyInstanceId: entry.ptyInstanceId,
        };
      })
      .sort(comparePtyLifetimeIdentities);
    const receipt = PtyHandoffReceiptSchema.parse({ terminals });
    return {
      ok: true,
      report: { adopted: report.adopted, failed: report.failed, receipt },
    };
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
  // The Host is spawned with ignored stdio; the composition decides process-group ownership.
  // NB: the host in turn spawns the node-pty BRIDGE with piped stdio — never copy
  // this detached/ignore shape onto the bridge or its PTYs die at spawn.
  const [command, ...args] = input.argv;
  return spawn(command, args, input.spawnOptions);
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
