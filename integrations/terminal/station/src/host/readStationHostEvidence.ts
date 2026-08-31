import {
  StationHostEndpointSchema,
  StationHostExactEvidenceSchema,
  StationHostInspectedHealthSchema,
} from "@station/contracts";
import {
  assertHostReusable,
  type HostHealthResult,
  isStationHostCompatibilityError,
  openStationHostLifecycleSession,
  type StationHostLifecycleSession,
} from "@station/host";
import { probeUnixSocket, readUnixSocketHolderPidsAsync } from "@station/protocol";
import type { z } from "zod";
import type {
  ChildProcessLike,
  SpawnStationHostInput,
  StationHostCommand,
} from "./ensureHostRunning.js";
import { startStationHostProcess } from "./hostProcess.js";

export type StationHostExactEvidence = z.infer<typeof StationHostExactEvidenceSchema>;
export type StationHostEndpointObservation =
  | { status: "absent" }
  | {
      status: "inaccessible";
      error: unknown;
      endpoint?: StationHostExactEvidence["endpoint"];
    }
  | { status: "listening" | "stale"; endpoint: StationHostExactEvidence["endpoint"] };
export type StationHostEndpointProbe = (
  socketPath: string,
  deadlineMs: number,
) => Promise<StationHostEndpointObservation>;
export type CausalStationHostEvidencePorts = {
  openSession: typeof openStationHostLifecycleSession;
  probeEndpoint: StationHostEndpointProbe;
  readHolders(socketPath: string, deadlineMs: number): Promise<readonly number[]>;
  now(): number;
};

/**
 * ADAPTER
 *
 * Binds a configured path to one physical socket lifetime before a deadline.
 */
export async function readStationHostEndpoint(
  socketPath: string,
  deadlineMs: number,
): Promise<StationHostEndpointObservation> {
  if (Date.now() >= deadlineMs) throw new Error("Station Host evidence deadline exceeded.");
  const found = await probeUnixSocket(socketPath, {
    timeoutMs: Math.max(1, deadlineMs - Date.now()),
    socketHolders: (path) => readUnixSocketHolderPidsAsync(path, { deadlineMs }),
  });
  if (Date.now() >= deadlineMs) throw new Error("Station Host evidence deadline exceeded.");
  if (found.status === "absent") return found;
  if (found.status === "inaccessible") {
    if (found.reason === "path-changed" && found.identity === undefined) {
      return { status: "absent" };
    }
    if (found.identity === undefined) return { status: found.status, error: found.error };
    return {
      status: found.status,
      error: found.error,
      endpoint: StationHostEndpointSchema.parse({ socketPath, ...found.identity }),
    };
  }
  return {
    status: found.status,
    endpoint: StationHostEndpointSchema.parse({ socketPath, ...found.identity }),
  };
}

/**
 * ADAPTER
 *
 * Reads exact Host evidence on one supplied physical lifecycle session.
 */
export async function readStationHostEvidence(input: {
  expectedEndpoint: StationHostExactEvidence["endpoint"];
  session: Pick<StationHostLifecycleSession, "health" | "recoveryInventory">;
  deadlineMs: number;
  probeEndpoint?: StationHostEndpointProbe;
}): Promise<StationHostExactEvidence> {
  const probe = input.probeEndpoint ?? readStationHostEndpoint;
  const before = await probe(input.expectedEndpoint.socketPath, input.deadlineMs);
  if (
    before.status !== "listening" ||
    !stationHostEndpointsMatch(before.endpoint, input.expectedEndpoint)
  )
    throw new Error("Station Host endpoint changed before exact evidence was read.");
  const health = StationHostInspectedHealthSchema.parse(await input.session.health());
  const inventory = await input.session.recoveryInventory();
  const afterHealth = StationHostInspectedHealthSchema.parse(await input.session.health());
  const after = await probe(input.expectedEndpoint.socketPath, input.deadlineMs);
  if (
    Date.now() >= input.deadlineMs ||
    !stationHostHealthMatches(health, afterHealth) ||
    after.status !== "listening" ||
    !stationHostEndpointsMatch(after.endpoint, input.expectedEndpoint)
  )
    throw new Error("Station Host evidence changed while it was read.");
  return StationHostExactEvidenceSchema.parse({
    endpoint: input.expectedEndpoint,
    health,
    buildIdentity: inventory.buildIdentity,
    terminals: inventory.ptys,
  });
}

type CausalCandidate = {
  endpoint: StationHostExactEvidence["endpoint"];
  health: HostHealthResult;
  holders: readonly number[];
  session: StationHostLifecycleSession;
};

/** Produces `E0 → H0 → holder → H1 → E1`; only dial/initial-health failures retry. */
async function readCausalCandidate(
  input: {
    socketPath: string;
    expectedBuildVersion: string;
    deadlineMs: number;
    validate?: (session: StationHostLifecycleSession) => Promise<void>;
  },
  ports: CausalStationHostEvidencePorts,
): Promise<CausalCandidate> {
  while (ports.now() < input.deadlineMs) {
    const e0 = await ports.probeEndpoint(input.socketPath, input.deadlineMs);
    if (e0.status === "absent" || e0.status === "stale") {
      await retryDelay(ports.now, input.deadlineMs);
      continue;
    }
    if (e0.status === "inaccessible") throw e0.error;
    let session: StationHostLifecycleSession | undefined;
    let admitted = false;
    try {
      session = await ports.openSession({
        socketPath: input.socketPath,
        expectedBuildVersion: input.expectedBuildVersion,
        deadlineMs: input.deadlineMs,
      });
      const h0 = await session.health();
      assertHostReusable(h0, input.expectedBuildVersion);
      admitted = true;
      await input.validate?.(session);
      const holders = await ports.readHolders(input.socketPath, input.deadlineMs);
      const h1 = await session.health();
      const e1 = await ports.probeEndpoint(input.socketPath, input.deadlineMs);
      if (
        ports.now() >= input.deadlineMs ||
        e1.status !== "listening" ||
        !stationHostEndpointsMatch(e0.endpoint, e1.endpoint) ||
        !stationHostHealthMatches(h0, h1)
      )
        throw new Error("Station Host causal readiness evidence changed.");
      return { endpoint: e1.endpoint, health: h1, holders, session };
    } catch (error) {
      session?.dispose();
      if (admitted || isStationHostCompatibilityError(error) || ports.now() >= input.deadlineMs)
        throw error;
      const current = await ports.probeEndpoint(input.socketPath, input.deadlineMs);
      if (
        current.status !== "listening" ||
        !stationHostEndpointsMatch(e0.endpoint, current.endpoint)
      )
        throw error;
      await retryDelay(ports.now, input.deadlineMs);
    }
  }
  throw new Error("Station Host causal readiness deadline exceeded.");
}

export type CausalStationHostStartResult =
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
 * Starts one direct child and transfers it only after cutoff-bound causal proof.
 */
export async function startCausalStationHost(
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
  overrides: Partial<CausalStationHostEvidencePorts> & {
    spawnHost?: (input: SpawnStationHostInput) => ChildProcessLike;
  } = {},
): Promise<CausalStationHostStartResult> {
  const ports: CausalStationHostEvidencePorts = {
    openSession: overrides.openSession ?? openStationHostLifecycleSession,
    probeEndpoint: overrides.probeEndpoint ?? readStationHostEndpoint,
    readHolders:
      overrides.readHolders ??
      ((path, deadlineMs) => readUnixSocketHolderPidsAsync(path, { deadlineMs })),
    now: overrides.now ?? Date.now,
  };
  let child: ReturnType<typeof startStationHostProcess> | undefined;
  let candidate: CausalCandidate | undefined;
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
    candidate = await readCausalCandidate(
      {
        socketPath: input.socketPath,
        expectedBuildVersion: input.expectedBuildVersion,
        deadlineMs: input.startupCutoffMs,
        ...(input.validate === undefined ? {} : { validate: input.validate }),
      },
      ports,
    );
    if (!child.transfer(candidate.holders, input.startupCutoffMs))
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

export function stationHostEndpointsMatch(
  left: StationHostExactEvidence["endpoint"],
  right: StationHostExactEvidence["endpoint"],
): boolean {
  return (
    left.socketPath === right.socketPath &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}
export function stationHostHealthMatches(
  left: { protocolVersion: number; buildVersion: string },
  right: { protocolVersion: number; buildVersion: string },
): boolean {
  return left.protocolVersion === right.protocolVersion && left.buildVersion === right.buildVersion;
}
export function stationHostEvidenceMatches(
  left: StationHostExactEvidence,
  right: StationHostExactEvidence,
): boolean {
  return (
    stationHostEndpointsMatch(left.endpoint, right.endpoint) &&
    stationHostHealthMatches(left.health, right.health) &&
    left.buildIdentity === right.buildIdentity &&
    JSON.stringify(left.terminals) === JSON.stringify(right.terminals)
  );
}
function retryDelay(now: () => number, deadlineMs: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Math.min(25, deadlineMs - now()))),
  );
}
