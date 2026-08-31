import type { StationHostExactEvidence } from "@station/contracts";
import {
  assertHostReusable,
  type HostHealthResult,
  isStationHostCompatibilityError,
  openStationHostLifecycleSession,
  type StationHostLifecycleSession,
} from "@station/host";
import { readUnixSocketHolderPidsAsync } from "@station/protocol";
import {
  type ChildProcessLike,
  type SpawnStationHostInput,
  type StationHostCommand,
  startStationHostProcess,
} from "./hostProcess.js";
import {
  readStationHostEndpoint,
  type StationHostEndpointProbe,
  stationHostEndpointsMatch,
  stationHostHealthMatches,
} from "./readStationHostEvidence.js";

/**
 * DRIVEN PORT
 *
 * Supplies the clock, endpoint evidence, holder evidence, and pinned session needed to prove a
 * freshly started Host owns its configured socket.
 */
export type StationHostStartupProofPorts = {
  openSession: typeof openStationHostLifecycleSession;
  probeEndpoint: StationHostEndpointProbe;
  readHolders(socketPath: string, deadlineMs: number): Promise<readonly number[]>;
  now(): number;
};

type StableHostCandidate = {
  endpoint: StationHostExactEvidence["endpoint"];
  health: HostHealthResult;
  holderPids: readonly number[];
  session: StationHostLifecycleSession;
};

async function readStableHostCandidate(
  input: {
    socketPath: string;
    expectedBuildVersion: string;
    deadlineMs: number;
    validate?: (session: StationHostLifecycleSession) => Promise<void>;
  },
  ports: StationHostStartupProofPorts,
): Promise<StableHostCandidate> {
  while (ports.now() < input.deadlineMs) {
    const endpointBefore = await ports.probeEndpoint(input.socketPath, input.deadlineMs);
    if (endpointBefore.status === "absent" || endpointBefore.status === "stale") {
      await retryDelay(ports.now, input.deadlineMs);
      continue;
    }
    if (endpointBefore.status === "inaccessible") throw endpointBefore.error;
    let session: StationHostLifecycleSession | undefined;
    let initialHealthAccepted = false;
    try {
      session = await ports.openSession({
        socketPath: input.socketPath,
        expectedBuildVersion: input.expectedBuildVersion,
        deadlineMs: input.deadlineMs,
      });
      const initialHealth = await session.health();
      assertHostReusable(initialHealth, input.expectedBuildVersion);
      initialHealthAccepted = true;
      await input.validate?.(session);
      const holderPids = await ports.readHolders(input.socketPath, input.deadlineMs);
      const confirmedHealth = await session.health();
      const endpointAfter = await ports.probeEndpoint(input.socketPath, input.deadlineMs);
      if (
        ports.now() >= input.deadlineMs ||
        endpointAfter.status !== "listening" ||
        !stationHostEndpointsMatch(endpointBefore.endpoint, endpointAfter.endpoint) ||
        !stationHostHealthMatches(initialHealth, confirmedHealth)
      )
        throw new Error("Station Host causal readiness evidence changed.");
      return {
        endpoint: endpointAfter.endpoint,
        health: confirmedHealth,
        holderPids,
        session,
      };
    } catch (error) {
      session?.dispose();
      // Once initial health is accepted, any later ownership-proof failure is terminal.
      if (
        initialHealthAccepted ||
        isStationHostCompatibilityError(error) ||
        ports.now() >= input.deadlineMs
      )
        throw error;
      const currentEndpoint = await ports.probeEndpoint(input.socketPath, input.deadlineMs);
      if (
        currentEndpoint.status !== "listening" ||
        !stationHostEndpointsMatch(endpointBefore.endpoint, currentEndpoint.endpoint)
      )
        throw error;
      await retryDelay(ports.now, input.deadlineMs);
    }
  }
  throw new Error("Station Host causal readiness deadline exceeded.");
}

export type StationHostStartResult =
  | {
      status: "transferred";
      endpoint: StationHostExactEvidence["endpoint"];
      health: HostHealthResult;
      session: StationHostLifecycleSession;
    }
  | { status: "failed"; error: unknown; childDisposition: "not-spawned" | "settled" | "unproven" };

/**
 * ADAPTER
 *
 * Starts one direct child and transfers it only after the endpoint and health remain stable across
 * canonical socket-holder evidence before the startup cutoff.
 */
export async function startStationHostWithOwnershipProof(
  input: {
    socketPath: string;
    stateDir: string;
    hostCommand: StationHostCommand;
    detached: boolean;
    expectedBuildVersion: string;
    startupCutoffMs: number;
    deadlineMs: number;
    validate?: (session: StationHostLifecycleSession) => Promise<void>;
  },
  overrides: Partial<StationHostStartupProofPorts> & {
    spawnHost?: (input: SpawnStationHostInput) => ChildProcessLike;
  } = {},
): Promise<StationHostStartResult> {
  const ports: StationHostStartupProofPorts = {
    openSession: overrides.openSession ?? openStationHostLifecycleSession,
    probeEndpoint: overrides.probeEndpoint ?? readStationHostEndpoint,
    readHolders:
      overrides.readHolders ??
      ((path, deadlineMs) => readUnixSocketHolderPidsAsync(path, { deadlineMs })),
    now: overrides.now ?? Date.now,
  };
  let child: ReturnType<typeof startStationHostProcess> | undefined;
  let candidate: StableHostCandidate | undefined;
  try {
    if (ports.now() >= input.startupCutoffMs)
      throw new Error("Station Host startup cutoff was reached before spawn.");
    child = startStationHostProcess(
      {
        argv: [...input.hostCommand, "--socket", input.socketPath, "--state-dir", input.stateDir],
        spawnOptions: { detached: input.detached, stdio: "ignore" },
      },
      {
        ...(overrides.spawnHost === undefined ? {} : { spawnHost: overrides.spawnHost }),
        now: ports.now,
      },
    );
    candidate = await readStableHostCandidate(
      {
        socketPath: input.socketPath,
        expectedBuildVersion: input.expectedBuildVersion,
        deadlineMs: input.startupCutoffMs,
        ...(input.validate === undefined ? {} : { validate: input.validate }),
      },
      ports,
    );
    if (!child.transfer(candidate.holderPids, input.startupCutoffMs))
      throw new Error("Station Host child ownership was not proven.");
    return {
      status: "transferred",
      endpoint: candidate.endpoint,
      health: candidate.health,
      session: candidate.session,
    };
  } catch (error) {
    candidate?.session.dispose();
    if (child === undefined) return { status: "failed", error, childDisposition: "not-spawned" };
    const settled = await child.cleanup(input.deadlineMs).catch(() => false);
    return { status: "failed", error, childDisposition: settled ? "settled" : "unproven" };
  }
}

function retryDelay(now: () => number, deadlineMs: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Math.min(25, deadlineMs - now()))),
  );
}
