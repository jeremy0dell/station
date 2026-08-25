import {
  StationHostEndpointSchema,
  StationHostExactEvidenceSchema,
  type StationHostInspectedHealth,
  StationHostInspectedHealthSchema,
  type StationHostInspectionResult,
} from "@station/contracts";
import {
  createStationHostClient,
  type HostRecoveryInventoryResult,
  type StationHostClient,
  stationHostSafeError,
} from "@station/host";
import { probeUnixSocket } from "@station/protocol";
import { safeErrorFromUnknown, stationBuildInfo } from "@station/runtime";

type InspectionClient = Pick<StationHostClient, "health" | "recoveryInventory" | "dispose">;
type EndpointProbe = Awaited<ReturnType<typeof defaultEndpointProbe>>;
export type InspectStationHostDeps = {
  probeEndpoint?: (socketPath: string) => Promise<EndpointProbe>;
  clientFactory?: (socketPath: string, expectedBuildVersion: string) => InspectionClient;
};
export type InspectStationHostOptions = { socketPath: string; expectedBuildVersion?: string };
const OptionsSchema = StationHostEndpointSchema.pick({ socketPath: true }).extend({
  expectedBuildVersion: StationHostInspectedHealthSchema.shape.buildVersion.optional(),
});
const probeError = stationHostSafeError("HOST_UNREACHABLE", "Endpoint probe failed.");
const inspectionError = stationHostSafeError("HOST_REQUEST_FAILED", "Inspection was not exact.");
/**
 * ADAPTER
 *
 * Reads one current Host lifetime without starting, replacing, handing off, or retaining a
 * connection. Exact evidence is correlated to the configured socket path across both probes.
 */
export async function inspectStationHost(
  options: InspectStationHostOptions,
  deps: InspectStationHostDeps = {},
): Promise<StationHostInspectionResult> {
  const { socketPath, expectedBuildVersion: requestedBuildVersion } = OptionsSchema.parse(options);
  const probeEndpoint = deps.probeEndpoint ?? defaultEndpointProbe;
  const initialProbe = await probeEndpoint(socketPath).catch(
    (cause): EndpointProbe => ({
      status: "inaccessible",
      error: safeErrorFromUnknown(cause, probeError),
    }),
  );
  if (initialProbe.status === "absent") return { status: "absent" };
  if (initialProbe.status === "inaccessible") return initialProbe;
  const endpoint = StationHostEndpointSchema.safeParse(initialProbe.endpoint);
  if (!endpoint.success || endpoint.data.socketPath !== socketPath) {
    return unknownInspection("endpoint-drift", endpoint.error);
  }
  if (initialProbe.status === "stale") return { status: "stale", endpoint: endpoint.data };
  const clientFactory =
    deps.clientFactory ??
    ((path, build) => createStationHostClient({ socketPath: path, expectedBuildVersion: build }));
  const expectedBuildVersion = requestedBuildVersion ?? stationBuildInfo().version;
  const discoveryClient = clientFactory(socketPath, expectedBuildVersion);
  let discoveredHealth: StationHostInspectedHealth;
  try {
    discoveredHealth = StationHostInspectedHealthSchema.parse(await discoveryClient.health());
  } catch (cause) {
    return unknownInspection("health-failed", cause);
  } finally {
    discoveryClient.dispose();
  }
  const client = clientFactory(socketPath, discoveredHealth.buildVersion);
  try {
    let initialHealth: StationHostInspectedHealth;
    try {
      initialHealth = StationHostInspectedHealthSchema.parse(await client.health());
    } catch (cause) {
      return unknownInspection("health-failed", cause);
    }
    if (!sameHealth(discoveredHealth, initialHealth)) return unknownInspection("health-drift");
    const inventory: HostRecoveryInventoryResult | ReturnType<typeof unknownInspection> =
      await client
        .recoveryInventory()
        .catch((cause) => unknownInspection("inventory-failed", cause));
    let finalHealth: StationHostInspectedHealth | undefined;
    let finalHealthFailure: unknown;
    try {
      finalHealth = StationHostInspectedHealthSchema.parse(await client.health());
    } catch (cause) {
      finalHealthFailure = cause;
    }
    let finalProbe: EndpointProbe;
    try {
      finalProbe = await probeEndpoint(socketPath);
    } catch (cause) {
      return unknownInspection("endpoint-drift", cause);
    }
    if (finalProbe.status !== "listening") {
      return unknownInspection(
        "endpoint-drift",
        finalProbe.status === "inaccessible" ? finalProbe.error : undefined,
      );
    }
    const finalEndpoint = StationHostEndpointSchema.safeParse(finalProbe.endpoint);
    if (
      !finalEndpoint.success ||
      finalEndpoint.data.socketPath !== endpoint.data.socketPath ||
      finalEndpoint.data.ino !== endpoint.data.ino ||
      finalEndpoint.data.birthtimeNs !== endpoint.data.birthtimeNs
    ) {
      return unknownInspection("endpoint-drift", finalEndpoint.error);
    }
    if (finalHealth === undefined) return unknownInspection("health-failed", finalHealthFailure);
    if (!sameHealth(initialHealth, finalHealth)) return unknownInspection("health-drift");
    if ("status" in inventory) return inventory;
    const exact = StationHostExactEvidenceSchema.safeParse({
      endpoint: endpoint.data,
      health: initialHealth,
      buildIdentity: inventory.buildIdentity,
      terminals: inventory.ptys,
    });
    return exact.success
      ? { status: "exact", evidence: exact.data }
      : unknownInspection("inventory-failed", exact.error);
  } finally {
    client.dispose();
  }
}
async function defaultEndpointProbe(socketPath: string) {
  const probe = await probeUnixSocket(socketPath);
  if (probe.status === "absent") return probe;
  if (probe.status === "inaccessible")
    return { status: "inaccessible", error: probe.error } as const;
  return { status: probe.status, endpoint: { socketPath, ...probe.identity } } as const;
}
function sameHealth(left: StationHostInspectedHealth, right: StationHostInspectedHealth): boolean {
  return left.protocolVersion === right.protocolVersion && left.buildVersion === right.buildVersion;
}
function unknownInspection(
  reason: Extract<StationHostInspectionResult, { status: "unknown" }>["reason"],
  cause?: unknown,
): Extract<StationHostInspectionResult, { status: "unknown" }> {
  return { status: "unknown", reason, error: safeErrorFromUnknown(cause, inspectionError) };
}
