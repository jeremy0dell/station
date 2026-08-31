import {
  StationHostEndpointSchema,
  type StationHostExactEvidence,
  StationHostExactEvidenceSchema,
  StationHostInspectedHealthSchema,
} from "@station/contracts";
import type { StationHostLifecycleSession } from "@station/host";
import { probeUnixSocket, readUnixSocketHolderPidsAsync } from "@station/protocol";

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
