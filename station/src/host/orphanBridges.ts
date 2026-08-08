import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  PtyBridgeParkStateSchema,
  type PtyBridgeParkState,
  PtyScreenSnapshotSchema,
  type PtyScreenSnapshot,
  PtyScrollbackExportSchema,
  type PtyScrollbackExport,
} from "@station/contracts";

export const DEFAULT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const SOCK_SUFFIX = ".sock";
const PARK_SUFFIX = ".park.json";

/** Durable bridge-park placement under the shared runtime directory. */
export function ptyBridgesDirectory(stateDir: string): string {
  return path.join(stateDir, "run", "pty-bridges");
}

export function bridgeControlSocketPath(directory: string, ptyId: string): string {
  return path.join(directory, `${ptyId}${SOCK_SUFFIX}`);
}

export function bridgeParkStatePath(directory: string, ptyId: string): string {
  return path.join(directory, `${ptyId}${PARK_SUFFIX}`);
}

export function bridgeScrollbackExportPath(directory: string, ptyId: string): string {
  return path.join(directory, `${ptyId}.scrollback.json`);
}

export function bridgeScreenSnapshotPath(directory: string, ptyId: string): string {
  return path.join(directory, `${ptyId}.screen.json`);
}

/** An unparsable or non-positive override degrades to the default instead of failing host startup. */
export function resolveOrphanTtlMs(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_ORPHAN_TTL_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_ORPHAN_TTL_MS;
  }
  return parsed;
}

export type OrphanBridgeReapResult = {
  reaped: number;
  parked: number;
};

/**
 * Clean-startup garbage collection for parked bridges: a socket that no bridge
 * answers and a park state with no socket are stale remains and are unlinked;
 * every live parked bridge is counted and left untouched (adoption is a
 * negotiated step, never an implicit startup side effect).
 */
export async function reapStaleOrphanBridges(
  directory: string,
  options: { probeTimeoutMs?: number } = {},
): Promise<OrphanBridgeReapResult> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return { reaped: 0, parked: 0 };
  }
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const socketIds: string[] = [];
  for (const name of names) {
    if (name.endsWith(SOCK_SUFFIX)) {
      socketIds.push(name.slice(0, -SOCK_SUFFIX.length));
    }
  }
  let reaped = 0;
  let parked = 0;
  for (const ptyId of socketIds) {
    const alive = await probeBridgeControlSocket(
      bridgeControlSocketPath(directory, ptyId),
      probeTimeoutMs,
    );
    if (alive) {
      parked += 1;
      continue;
    }
    await removeBridgeFiles(directory, ptyId);
    reaped += 1;
  }
  // A parked bridge always serves its socket, so a lone park state is stale.
  for (const name of names) {
    if (!name.endsWith(PARK_SUFFIX)) {
      continue;
    }
    const ptyId = name.slice(0, -PARK_SUFFIX.length);
    if (socketIds.includes(ptyId)) {
      continue;
    }
    await removeBridgeFiles(directory, ptyId);
    reaped += 1;
  }
  return { reaped, parked };
}

/** Poll until a parked bridge answers exit-status, or the deadline elapses. */
export async function waitForParkedBridge(
  socketPath: string,
  options: { timeoutMs?: number; probeTimeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 200;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeBridgeControlSocket(socketPath, probeTimeoutMs)) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** Connect-and-query liveness probe; any failure or silence reads as dead. */
export function probeBridgeControlSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(alive);
    };
    const probe = net.connect(socketPath);
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    probe.on("connect", () => {
      probe.write(`${JSON.stringify({ type: "exit-status" })}\n`);
    });
    probe.on("data", () => {
      finish(true);
    });
    probe.on("error", () => {
      finish(false);
    });
  });
}

export async function removeBridgeFiles(directory: string, ptyId: string): Promise<void> {
  for (const filePath of [
    bridgeControlSocketPath(directory, ptyId),
    bridgeParkStatePath(directory, ptyId),
    bridgeScrollbackExportPath(directory, ptyId),
    bridgeScreenSnapshotPath(directory, ptyId),
  ]) {
    try {
      await unlink(filePath);
    } catch {
      // Already gone.
    }
  }
}

/** Strictly parse durable park state; unreadable or invalid files read as absent. */
export async function readBridgeParkState(
  parkStatePath: string,
): Promise<PtyBridgeParkState | undefined> {
  const raw = await readFileQuiet(parkStatePath);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return PtyBridgeParkStateSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function writeScrollbackExport(
  directory: string,
  ptyId: string,
  exportData: PtyScrollbackExport,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const finalPath = bridgeScrollbackExportPath(directory, ptyId);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(exportData)}\n`, "utf8");
  await rename(tmpPath, finalPath);
  return finalPath;
}

export async function readScrollbackExport(
  scrollbackRef: string,
): Promise<PtyScrollbackExport | undefined> {
  const raw = await readFileQuiet(scrollbackRef);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return PtyScrollbackExportSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function writeScreenSnapshot(
  directory: string,
  ptyId: string,
  snapshot: PtyScreenSnapshot,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const finalPath = bridgeScreenSnapshotPath(directory, ptyId);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  await rename(tmpPath, finalPath);
  return finalPath;
}

export async function readScreenSnapshot(
  screenSnapshotRef: string,
): Promise<PtyScreenSnapshot | undefined> {
  const raw = await readFileQuiet(screenSnapshotRef);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return PtyScreenSnapshotSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function readFileQuiet(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}
