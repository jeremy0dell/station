import { existsSync } from "node:fs";
import type {
  StationHostConvergenceCommand,
  StationHostConvergenceResult,
  StationHostInspectionResult,
  StationHostTargetBuild,
  StationHostTerminalLifetime,
} from "@station/contracts";
import {
  assertHostReusable,
  classifyHostCompatibility,
  createStationHostClient,
  isStationHostCompatibilityError,
  stationHostSafeError,
  type HostHealthResult,
  type HostListEntry,
} from "@station/host";
import { stationBuildInfo } from "@station/runtime";
import { inspectStationHost } from "@station/terminal";

/** One bounded default boot negotiation; exact-gated convergence has its own command deadline. */
export const HOST_LIST_TIMEOUT_MS = 1000;

type ListClient = {
  health(): Promise<HostHealthResult>;
  list(): Promise<readonly HostListEntry[]>;
  stopIfIdle(requestingBuildVersion: string): Promise<{ stopping: true }>;
  dispose(): void;
};
export type ListLiveHostPtysDeps = {
  createClient?: (socketPath: string) => ListClient;
  timeoutMs?: number;
  expectedBuildVersion?: string;
  expectedBuildIdentity?: string;
  env?: Readonly<Record<string, string | undefined>>;
  inspectHost?: typeof inspectStationHost;
  convergeExactHost?: (
    command: StationHostConvergenceCommand,
  ) => Promise<StationHostConvergenceResult>;
  now?: () => number;
};

/**
 * ADAPTER
 *
 * Keeps default display-compatible boot unchanged. Exact `STATION_HOST_HANDOFF=1` instead requires
 * immutable inspection and canonical convergence, with no `host.list` or cold fallback.
 */
export async function listLiveHostPtys(
  socketPath: string,
  deps: ListLiveHostPtysDeps = {},
): Promise<readonly HostListEntry[] | undefined> {
  if (!existsSync(socketPath)) return undefined;
  const targetBuild = resolveTargetBuild(deps);
  if ((deps.env ?? process.env).STATION_HOST_HANDOFF === "1")
    return listExactHostPtys(socketPath, targetBuild, deps);
  return listCompatibleHostPtys(socketPath, targetBuild.buildVersion, deps);
}

function resolveTargetBuild(deps: ListLiveHostPtysDeps): StationHostTargetBuild {
  if (deps.expectedBuildVersion !== undefined && deps.expectedBuildIdentity !== undefined) {
    return {
      buildVersion: deps.expectedBuildVersion,
      buildIdentity: deps.expectedBuildIdentity,
    };
  }
  const build = stationBuildInfo();
  return {
    buildVersion: deps.expectedBuildVersion ?? build.version,
    buildIdentity: deps.expectedBuildIdentity ?? build.buildIdentity,
  };
}

async function listExactHostPtys(
  socketPath: string,
  targetBuild: StationHostTargetBuild,
  deps: ListLiveHostPtysDeps,
): Promise<readonly HostListEntry[]> {
  const inspection = await (deps.inspectHost ?? inspectStationHost)({
    socketPath,
    expectedBuildVersion: targetBuild.buildVersion,
    deadlineMs: (deps.now ?? Date.now)() + 5_000,
  });
  if (inspection.status !== "exact") throw exactInspectionFailure(inspection);
  const evidence = inspection.evidence;
  if (
    evidence.health.buildVersion === targetBuild.buildVersion &&
    evidence.buildIdentity === targetBuild.buildIdentity
  )
    return evidence.terminals.map(publicHostEntry);
  if (
    evidence.terminals.length > 0 &&
    !evidence.terminals.every(
      ({ alive, handoffSupport }) => alive && handoffSupport.kind === "bridge-releasable",
    )
  )
    throw stationHostSafeError(
      "HOST_UPGRADE_BLOCKED",
      "The exact Host terminal registry is not eligible for live handoff.",
    );
  if (deps.convergeExactHost === undefined)
    throw stationHostSafeError(
      "HOST_VERSION_INCOMPATIBLE",
      "Exact Host convergence is unavailable in this Station composition.",
    );
  const common = {
    targetBuild,
    socketPath,
    expected: evidence,
    deadlineMs: (deps.now ?? Date.now)() + 12_000,
  };
  const command: StationHostConvergenceCommand =
    evidence.terminals.length === 0
      ? { ...common, action: "replace-idle" }
      : { ...common, action: "handoff", fidelity: "processes" };
  const result = await deps.convergeExactHost(command);
  if (result.status === "failed") throw result.error;
  return result.finalEvidence.terminals.map(publicHostEntry);
}

async function listCompatibleHostPtys(
  socketPath: string,
  expectedBuildVersion: string,
  deps: ListLiveHostPtysDeps,
): Promise<readonly HostListEntry[] | undefined> {
  const timeoutMs = deps.timeoutMs ?? HOST_LIST_TIMEOUT_MS;
  const client =
    deps.createClient?.(socketPath) ??
    createStationHostClient({ socketPath, expectedBuildVersion });
  const state = { incompatibleHostDetected: false };
  const operation = negotiateHostPtys(client, expectedBuildVersion, state);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<readonly HostListEntry[] | undefined>((resolve, reject) => {
    timer = setTimeout(
      () =>
        state.incompatibleHostDetected
          ? reject(hostCompatibilityUnconfirmed())
          : resolve(undefined),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (isStationHostCompatibilityError(error)) throw error;
    if (state.incompatibleHostDetected) throw hostCompatibilityUnconfirmed();
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    client.dispose();
  }
}

async function negotiateHostPtys(
  client: ListClient,
  expectedBuildVersion: string,
  state: { incompatibleHostDetected: boolean },
): Promise<readonly HostListEntry[] | undefined> {
  const health = await client.health();
  const compatibility = classifyHostCompatibility(health, expectedBuildVersion);
  if (compatibility.action === "reuse") return client.list();
  state.incompatibleHostDetected = true;
  if (compatibility.action === "refuse") {
    assertHostReusable(health, expectedBuildVersion);
    return undefined;
  }
  await client.stopIfIdle(expectedBuildVersion);
  return undefined;
}

function publicHostEntry(terminal: StationHostTerminalLifetime): HostListEntry {
  const {
    handoffSupport: _handoffSupport,
    ...entry
  } = terminal;
  return entry;
}

function exactInspectionFailure(inspection: StationHostInspectionResult) {
  if (inspection.status === "inaccessible" || inspection.status === "unknown") return inspection.error;
  return stationHostSafeError(
    "HOST_VERSION_INCOMPATIBLE",
    "Exact Host evidence disappeared or became stale during native startup.",
  );
}

function hostCompatibilityUnconfirmed() {
  return stationHostSafeError(
    "HOST_VERSION_INCOMPATIBLE",
    "Station host upgrade could not be completed safely.",
    {
      hint: "The existing host and terminals were preserved. Retry, or reopen with the running build.",
    },
  );
}
