import {
  StationHostEndpointSchema,
  StationHostExactEvidenceSchema,
  type StationHostInspectedHealth,
  StationHostInspectedHealthSchema,
  type StationHostInspectionResult,
} from "@station/contracts";
import {
  HostHealthResultSchema,
  type HostRecoveryInventoryResult,
  openStationHostLifecycleSession,
  type StationHostLifecycleSession,
  stationHostCompatibilityError,
  stationHostSafeError,
} from "@station/host";
import { safeErrorFromUnknown, stationBuildInfo } from "@station/runtime";
import { z } from "zod";
import {
  readStationHostEndpoint,
  type StationHostEndpointProbe,
  stationHostEndpointsMatch,
  stationHostHealthMatches,
} from "./readStationHostEvidence.js";

type OpenInspectionSession = (input: {
  socketPath: string;
  expectedBuildVersion: string;
  deadlineMs: number;
}) => Promise<StationHostLifecycleSession>;
export type InspectStationHostDeps = {
  probeEndpoint?: StationHostEndpointProbe;
  openSession?: OpenInspectionSession;
};
export type InspectStationHostOptions = {
  socketPath: string;
  expectedBuildVersion?: string;
  deadlineMs?: number;
};
const OptionsSchema = StationHostEndpointSchema.pick({ socketPath: true }).extend({
  expectedBuildVersion: StationHostInspectedHealthSchema.shape.buildVersion.optional(),
  deadlineMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
const probeError = stationHostSafeError("HOST_UNREACHABLE", "Endpoint probe failed.");
const inspectionError = stationHostSafeError("HOST_REQUEST_FAILED", "Inspection was not exact.");

/**
 * ADAPTER
 *
 * Reads one current Host lifetime without mutation or retained authority. Discovery and exact
 * inventory use disposable, non-reconnecting sessions bounded by one absolute deadline.
 */
export async function inspectStationHost(
  options: InspectStationHostOptions,
  deps: InspectStationHostDeps = {},
): Promise<StationHostInspectionResult> {
  const parsed = OptionsSchema.parse(options);
  const deadlineMs = parsed.deadlineMs ?? Date.now() + 5_000;
  const probe = deps.probeEndpoint ?? readStationHostEndpoint;
  const initial = await probe(parsed.socketPath, deadlineMs).catch((cause) => ({
    status: "inaccessible" as const,
    error: safeErrorFromUnknown(cause, probeError),
  }));
  if (initial.status === "absent") return initial;
  if (initial.status === "inaccessible")
    return { status: "inaccessible", error: safeErrorFromUnknown(initial.error, probeError) };
  const endpoint = StationHostEndpointSchema.safeParse(initial.endpoint);
  if (!endpoint.success || endpoint.data.socketPath !== parsed.socketPath)
    return unknownInspection("endpoint-drift", endpoint.error);
  if (initial.status === "stale") return { status: "stale", endpoint: endpoint.data };

  const open = deps.openSession ?? openStationHostLifecycleSession;
  const requestedBuild = parsed.expectedBuildVersion ?? stationBuildInfo().version;
  const discovered = await readDiscoveryHealth(open, parsed.socketPath, requestedBuild, deadlineMs);
  if (discovered.status === "failed") return unknownInspection("health-failed", discovered.error);

  let session: StationHostLifecycleSession | undefined;
  try {
    session = await open({
      socketPath: parsed.socketPath,
      expectedBuildVersion: discovered.health.buildVersion,
      deadlineMs,
    });
    let initialHealth: StationHostInspectedHealth;
    try {
      initialHealth = parseInspectedHealth(await session.health(), requestedBuild);
    } catch (cause) {
      return unknownInspection("health-failed", cause);
    }
    if (!stationHostHealthMatches(discovered.health, initialHealth))
      return unknownInspection("health-drift");
    let inventory: HostRecoveryInventoryResult | undefined;
    let inventoryFailure: unknown;
    try {
      inventory = await session.recoveryInventory();
    } catch (cause) {
      inventoryFailure = cause;
    }
    let finalHealth: StationHostInspectedHealth;
    try {
      finalHealth = parseInspectedHealth(await session.health(), requestedBuild);
    } catch (cause) {
      return unknownInspection("health-failed", cause);
    }
    const final = await probe(parsed.socketPath, deadlineMs).catch((cause) => ({
      status: "inaccessible" as const,
      error: cause,
    }));
    if (final.status !== "listening" || !stationHostEndpointsMatch(endpoint.data, final.endpoint))
      return unknownInspection(
        "endpoint-drift",
        final.status === "inaccessible" ? final.error : undefined,
      );
    if (!stationHostHealthMatches(initialHealth, finalHealth))
      return unknownInspection("health-drift");
    if (inventory === undefined) return unknownInspection("inventory-failed", inventoryFailure);
    const evidence = StationHostExactEvidenceSchema.safeParse({
      endpoint: endpoint.data,
      health: initialHealth,
      buildIdentity: inventory.buildIdentity,
      terminals: inventory.ptys,
    });
    return evidence.success
      ? { status: "exact", evidence: evidence.data }
      : unknownInspection("inventory-failed", evidence.error);
  } finally {
    session?.dispose();
  }
}

async function readDiscoveryHealth(
  open: OpenInspectionSession,
  socketPath: string,
  expectedBuildVersion: string,
  deadlineMs: number,
): Promise<
  { status: "read"; health: StationHostInspectedHealth } | { status: "failed"; error: unknown }
> {
  let session: StationHostLifecycleSession | undefined;
  try {
    session = await open({ socketPath, expectedBuildVersion, deadlineMs });
    return {
      status: "read",
      health: parseInspectedHealth(await session.health(), expectedBuildVersion),
    };
  } catch (error) {
    return { status: "failed", error };
  } finally {
    session?.dispose();
  }
}

function parseInspectedHealth(
  value: unknown,
  expectedBuildVersion: string,
): StationHostInspectedHealth {
  const current = StationHostInspectedHealthSchema.safeParse(value);
  if (current.success) return current.data;
  const raw = HostHealthResultSchema.safeParse(value);
  if (raw.success) {
    const compatibility = stationHostCompatibilityError(raw.data, expectedBuildVersion);
    if (compatibility !== undefined) throw compatibility;
  }
  throw current.error;
}

function unknownInspection(
  reason: Extract<StationHostInspectionResult, { status: "unknown" }>["reason"],
  cause?: unknown,
): Extract<StationHostInspectionResult, { status: "unknown" }> {
  return { status: "unknown", reason, error: safeErrorFromUnknown(cause, inspectionError) };
}
