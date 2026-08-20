import { createHash } from "node:crypto";
import { type StationConfig, stationHostSocketPath } from "@station/config";
import type {
  ObserverRepairInventory,
  RepairFinding,
  RepairInventory,
  RepairRuntimeOwnership,
} from "@station/contracts";
import { RepairInventorySchema } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { toIsoTimestamp } from "@station/runtime";
import { getObserverStatus, type ObserverProcessDeps } from "../../observerProcess.js";
import { resolveObserverPaths } from "../../paths.js";
import { resolveStationHostCommand } from "../host/index.js";
import {
  createLocalRepairRuntimeEvidence,
  type RepairLocalRuntimeEvidence,
} from "./localRuntimeEvidence.js";

export type RepairInventoryOptions = {
  config: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export type RepairCommandDeps = {
  observer?: ObserverProcessDeps;
  runtimeEvidence?: RepairLocalRuntimeEvidence;
  now?: () => Date;
};

/**
 * ADAPTER
 *
 * Aggregates one non-starting Observer query with read-only local Observer/Host/process evidence.
 * The result is evidence only; a future executor must re-inventory and exactly revalidate it.
 */
export async function captureRepairInventory(
  options: RepairInventoryOptions,
  deps: RepairCommandDeps = {},
): Promise<RepairInventory> {
  const paths = resolveObserverPaths(options.config);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const status = await getObserverStatus(
    {
      config: options.config,
      paths,
      timeoutMs,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    },
    deps.observer,
  );
  const runtimeEvidence = deps.runtimeEvidence ?? createLocalRepairRuntimeEvidence();
  const [observer, host] = await Promise.all([
    runtimeEvidence.inspectObserver({ socketPath: paths.socketPath, status }),
    runtimeEvidence.inspectHost({
      socketPath: stationHostSocketPath(options.config),
      stateDir: paths.stateDir,
      expectedHostCommand: resolveStationHostCommand(),
    }),
  ]);
  const observerInventory = await readObserverInventory(status, paths.socketPath, timeoutMs, deps);
  const findings = inventoryFindings(
    observer,
    host.ownership,
    host.terminalGroups,
    observerInventory,
  );
  const completeness: RepairInventory["completeness"] = findings.some(
    (finding) => finding.severity === "blocker",
  )
    ? "partial"
    : "complete";
  const capturedAt = toIsoTimestamp((deps.now ?? (() => new Date()))());
  const base = {
    schemaVersion: 1 as const,
    capturedAt,
    completeness,
    observer,
    host: host.ownership,
    terminalGroups: host.terminalGroups,
    sessions: observerInventory?.sessions ?? [],
    recoveryHandles: observerInventory?.recoveryHandles ?? [],
    findings,
  };
  const inventoryDigest = canonicalRepairDigest(repairInventoryDigestProjection(base));
  return RepairInventorySchema.parse({ ...base, inventoryDigest });
}

async function readObserverInventory(
  status: Awaited<ReturnType<typeof getObserverStatus>>,
  socketPath: string,
  timeoutMs: number,
  deps: RepairCommandDeps,
): Promise<ObserverRepairInventory | undefined> {
  if (status.status !== "running") return undefined;
  const client =
    deps.observer?.clientFactory?.(socketPath, {
      timeoutMs,
      ...(status.health.pid === undefined || status.health.startedAt === undefined
        ? {}
        : {
            expectedObserverIdentity: {
              pid: status.health.pid,
              startedAt: status.health.startedAt,
              socketPath,
              ...(status.health.version === undefined ? {} : { version: status.health.version }),
            },
          }),
    }) ??
    createObserverClient({
      socketPath,
      timeoutMs,
      ...(status.health.pid === undefined || status.health.startedAt === undefined
        ? status.health.version === undefined
          ? {}
          : { expectedBuildVersion: status.health.version }
        : {
            expectedObserverIdentity: {
              pid: status.health.pid,
              startedAt: status.health.startedAt,
              socketPath,
              ...(status.health.version === undefined ? {} : { version: status.health.version }),
            },
          }),
    });
  try {
    return await client.inspectRepairInventory();
  } catch {
    return undefined;
  }
}

function inventoryFindings(
  observer: RepairRuntimeOwnership,
  host: RepairRuntimeOwnership,
  groups: RepairInventory["terminalGroups"],
  observerInventory: ObserverRepairInventory | undefined,
): RepairFinding[] {
  const findings: RepairFinding[] = [];
  if (observerInventory === undefined) {
    findings.push({
      severity: "blocker",
      code: "OBSERVER_REPAIR_INVENTORY_UNAVAILABLE",
      message:
        "Retained sessions and recovery handles could not be read without starting or replacing the Observer.",
      recoveryCommands: [["stn", "observer", "status"]],
    });
  }
  if (observer.status === "uncertain" || observer.status === "unavailable") {
    findings.push({
      severity: "blocker",
      code: observer.refusalCode ?? "OBSERVER_OWNERSHIP_UNCERTAIN",
      message: "Observer ownership could not be proven from exact socket and process evidence.",
      recoveryCommands: [["stn", "observer", "status"]],
    });
  }
  if (observer.status === "stale") {
    findings.push({
      severity: "blocker",
      code: "OBSERVER_STALE_EVIDENCE",
      message: "The Observer socket is stale; repair inventory will not clean it up.",
      recoveryCommands: [["stn", "observer", "status"]],
    });
  }
  if (host.status === "uncertain" || host.status === "stale" || host.status === "unavailable") {
    findings.push({
      severity: "blocker",
      code: host.refusalCode ?? "HOST_OWNERSHIP_UNCERTAIN",
      message: "Station Host ownership or socket lifetime could not be proven.",
      recoveryCommands: [["stn", "host", "status"]],
    });
  }
  for (const group of groups) {
    if (group.disposition === "refused") {
      findings.push({
        severity: "blocker",
        code: group.refusalCode ?? "TERMINAL_GROUP_UNVERIFIED",
        message: "A Host PTY could not be correlated with stable OS process-group evidence.",
        targetKey: group.targetKey,
        recoveryCommands: [["stn", "repair", "inventory", "--json"]],
      });
    } else if (group.disposition === "non-recoverable") {
      findings.push({
        severity: "warning",
        code: "AUX_PTY_NON_RECOVERABLE",
        message: "Auxiliary PTYs are visible but are never runtime repair targets.",
        targetKey: group.targetKey,
        recoveryCommands: [],
      });
    }
  }
  return findings.sort((left, right) => findingKey(left).localeCompare(findingKey(right)));
}

function findingKey(finding: RepairFinding): string {
  return `${finding.severity}:${finding.code}:${finding.targetKey ?? ""}`;
}

type RepairInventoryDigestSource = Omit<RepairInventory, "inventoryDigest">;

export function repairInventoryDigestProjection(inventory: RepairInventoryDigestSource): unknown {
  return {
    schemaVersion: inventory.schemaVersion,
    completeness: inventory.completeness,
    observer: inventory.observer,
    host: inventory.host,
    terminalGroups: inventory.terminalGroups,
    sessions: inventory.sessions,
    recoveryHandles: inventory.recoveryHandles,
    findings: inventory.findings.map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      ...(finding.targetKey === undefined ? {} : { targetKey: finding.targetKey }),
    })),
  };
}

export function canonicalRepairDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}
