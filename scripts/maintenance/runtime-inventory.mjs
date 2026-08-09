#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  inspectDisposableRuntimeOwners,
  inspectRuntimeProcessIdentity,
} from "../runtime-owner.mjs";

const lifecycleLog = "logs/cli.jsonl";

if (isMain()) {
  try {
    const options = parseRuntimeInventoryArgs(process.argv.slice(2));
    const inventory = await buildRuntimeInventory(options);
    process.stdout.write(
      options.json ? `${JSON.stringify(inventory)}\n` : formatRuntimeInventory(inventory),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Runtime inventory failed."}\n`,
    );
    process.exitCode = 1;
  }
}

export function parseRuntimeInventoryArgs(args) {
  const options = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--state-dir") {
      const stateDir = args[index + 1];
      if (stateDir === undefined || !isAbsolute(stateDir)) {
        throw new Error("--state-dir requires an absolute path.");
      }
      options.stateDir = resolve(stateDir);
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printRuntimeInventoryHelp();
      process.exit(0);
    }
    throw new Error(`Unknown runtime inventory option: ${arg}`);
  }
  return options;
}

export async function buildRuntimeInventory(options = {}) {
  const stateDir = options.stateDir ?? (await resolveRuntimeStateDir());
  const owners = await inspectDisposableRuntimeOwners(stateDir);
  const runtimeRecords = owners.records.filter((entry) => entry.record !== undefined);
  const hostEvidence = await inspectRegisteredRuntimeHosts(runtimeRecords);
  const host = projectRuntimeHosts(hostEvidence);
  return {
    mode: "read-only",
    ownerRecords: {
      state: owners.state,
      count: owners.records.length,
      ...(owners.refusalCode === undefined ? {} : { refusalCode: owners.refusalCode }),
    },
    runtimes: owners.records.map((entry) => projectRuntime(entry)),
    host,
    evidence: {
      lifecycleLog,
      ...(owners.refusalCode === undefined ? {} : { refusalCode: owners.refusalCode }),
    },
  };
}

function projectRuntime(entry) {
  if (entry.record === undefined) {
    return { state: "refused", refusalCode: entry.refusalCode };
  }
  const { record, ownerIdentity, processGroup, lastEvent } = entry;
  const refusalReasons = [
    ...(ownerIdentity === "exact" || ownerIdentity === "absent" ? [] : [`owner-${ownerIdentity}`]),
    ...(processGroup.kind === "exact" ||
    processGroup.kind === "absent" ||
    processGroup.kind === "unstarted"
      ? []
      : [processGroup.code ?? `process-group-${processGroup.kind}`]),
  ];
  return {
    state: refusalReasons.length === 0 ? "inspectable" : "refused",
    liveness: runtimeLiveness(ownerIdentity, processGroup.kind),
    runtimeId: record.runtimeId,
    role: record.role,
    disposition: record.disposition,
    runtimeKey: record.runtimeKey,
    checkout: {
      key: record.checkout.key,
      identity: `${record.checkout.device}:${record.checkout.inode}`,
    },
    owner: projectProcessIdentity(record.owner, ownerIdentity),
    ...(record.processGroup === undefined
      ? {}
      : {
          processGroup: projectProcessIdentity(
            record.processGroup,
            processGroup.kind,
            processGroup.members,
          ),
        }),
    socketRoots: projectRoots(record.socketRoots),
    persistenceRoots: projectRoots(record.persistenceRoots),
    survivorPolicy: record.survivorPolicy,
    ownerState: record.state,
    lifecycle:
      lastEvent === undefined
        ? { state: "unavailable", log: lifecycleLog }
        : {
            state: "available",
            event: lastEvent.message,
            traceId: lastEvent.traceId,
            log: lifecycleLog,
          },
    ...(refusalReasons.length === 0 ? {} : { refusalReasons }),
  };
}

function runtimeLiveness(ownerIdentity, processGroupIdentity) {
  if (processGroupIdentity === "exact" && ownerIdentity !== "absent") return "active";
  if (ownerIdentity === "absent" && processGroupIdentity === "exact") return "orphaned";
  if (ownerIdentity === "absent" && processGroupIdentity === "absent") return "exited";
  if (processGroupIdentity === "unstarted") return "registered";
  return "refused";
}

function projectProcessIdentity(identity, state, members) {
  return {
    pid: identity.pid,
    pgid: identity.pgid,
    osStartTime: identity.osStartTime,
    state,
    ...(members === undefined ? {} : { memberCount: members.length }),
  };
}

function projectRoots(roots) {
  return { count: roots.length, key: hashValues(roots) };
}

/** Inspect every registered Host socket and live PTY without changing runtime state. */
export async function inspectRegisteredRuntimeHosts(records) {
  const socketPaths = [
    ...new Set(
      records.flatMap(({ record }) =>
        record.socketRoots.map((root) => join(root, "station-host.sock")),
      ),
    ),
  ];
  if (socketPaths.length === 0) {
    return { state: "unavailable", hosts: [], refusalCode: "HOST_SOCKET_UNREGISTERED" };
  }
  const hosts = [];
  for (const socketPath of socketPaths) {
    let metadata;
    try {
      metadata = await lstat(socketPath);
    } catch (cause) {
      const error = ErrorCodeSchema.safeParse(cause);
      if (error.success && error.data.code === "ENOENT") {
        hosts.push({ socketPath, state: "absent" });
        continue;
      }
      hosts.push({ socketPath, state: "refused", refusalCode: "HOST_SOCKET_UNAVAILABLE" });
      continue;
    }
    if (!metadata.isSocket() || metadata.isSymbolicLink()) {
      hosts.push({ socketPath, state: "refused", refusalCode: "HOST_SOCKET_INSECURE" });
      continue;
    }

    let holders;
    try {
      const protocol = await import("../../packages/protocol/dist/index.js");
      holders = protocol.readUnixSocketHolderPids(socketPath);
    } catch {
      hosts.push({ socketPath, state: "refused", refusalCode: "HOST_HOLDER_UNAVAILABLE" });
      continue;
    }
    if (holders.length === 0) {
      hosts.push({
        socketPath,
        state: "stale",
        socketIdentity: `${metadata.dev}:${metadata.ino}`,
      });
      continue;
    }
    if (holders.length !== 1) {
      hosts.push({ socketPath, state: "refused", refusalCode: "HOST_HOLDER_AMBIGUOUS" });
      continue;
    }
    const holder = inspectRuntimeProcessIdentity(holders[0]);
    if (holder.state !== "available") {
      hosts.push({ socketPath, state: "refused", refusalCode: "HOST_HOLDER_UNAVAILABLE" });
      continue;
    }

    let probe;
    let client;
    try {
      const { createStationHostClient } = await import("../../packages/station-host/dist/index.js");
      probe = createStationHostClient({
        socketPath,
        timeoutMs: 1_000,
        expectedBuildVersion: "runtime-inventory",
      });
      const health = await probe.health();
      client = createStationHostClient({
        socketPath,
        timeoutMs: 1_000,
        expectedBuildVersion: health.buildVersion,
      });
      const ptys = await client.list();
      const livePtys = ptys
        .filter((pty) => pty.alive)
        .map((pty) => inspectRuntimeProcessIdentity(pty.pid));
      if (livePtys.some((identity) => identity.state !== "available")) {
        hosts.push({ socketPath, state: "refused", refusalCode: "HOST_PTY_UNAVAILABLE" });
        continue;
      }
      hosts.push({
        socketPath,
        state: "available",
        socketIdentity: `${metadata.dev}:${metadata.ino}`,
        holder,
        livePtys,
      });
    } catch (cause) {
      hosts.push({ socketPath, state: "refused", refusalCode: hostRefusalCode(cause) });
    } finally {
      probe?.dispose();
      client?.dispose();
    }
  }
  const refused = hosts.find((host) => host.state === "refused");
  return {
    state: refused === undefined ? "available" : "refused",
    hosts,
    ...(refused?.refusalCode === undefined ? {} : { refusalCode: refused.refusalCode }),
  };
}

const ErrorCodeSchema = z.object({ code: z.string() }).loose();

function hostRefusalCode(cause) {
  const parsed = ErrorCodeSchema.safeParse(cause);
  return parsed.success ? parsed.data.code : "HOST_UNREACHABLE";
}

function projectRuntimeHosts(evidence) {
  if (evidence.state === "unavailable") {
    return { state: "unavailable", refusalCode: evidence.refusalCode };
  }
  if (evidence.state === "refused") {
    return { state: "unavailable", refusalCode: evidence.refusalCode };
  }
  const available = evidence.hosts.filter((host) => host.state === "available");
  if (available.length === 0) return { state: "unavailable", refusalCode: "HOST_UNREACHABLE" };
  return {
    state: "available",
    livePtyCount: available.reduce((count, host) => count + host.livePtys.length, 0),
  };
}

export async function resolveRuntimeStateDir() {
  try {
    const configModule = await import("../../packages/config/dist/index.js");
    const loaded = await configModule.loadConfig();
    return configModule.resolveObserverPaths(loaded.config).stateDir;
  } catch {
    return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "station");
  }
}

function hashValues(values) {
  return createHash("sha256")
    .update([...values].sort().join("\0"))
    .digest("hex");
}

export function formatRuntimeInventory(inventory) {
  const lines = ["Station runtime inventory (read-only)"];
  lines.push(`owner records: ${inventory.ownerRecords.state} (${inventory.ownerRecords.count})`);
  for (const runtime of inventory.runtimes) {
    if (runtime.state === "refused") {
      lines.push(
        `- record: refused (${runtime.refusalCode ?? runtime.refusalReasons?.join(", ")})`,
      );
      continue;
    }
    lines.push(`- ${runtime.role} ${runtime.runtimeId}: ${runtime.state}`);
    lines.push(`  liveness: ${runtime.liveness}; runtime ${runtime.runtimeKey}`);
    lines.push(`  checkout: ${runtime.checkout.key} (${runtime.checkout.identity})`);
    lines.push(
      `  owner: pid ${runtime.owner.pid}, pgid ${runtime.owner.pgid}, ${runtime.owner.osStartTime}, ${runtime.owner.state}`,
    );
    if (runtime.processGroup !== undefined) {
      lines.push(
        `  group: pid ${runtime.processGroup.pid}, pgid ${runtime.processGroup.pgid}, ${runtime.processGroup.osStartTime}, ${runtime.processGroup.state}`,
      );
    }
    lines.push(
      `  roots: sockets ${runtime.socketRoots.count}/${runtime.socketRoots.key}; persistence ${runtime.persistenceRoots.count}/${runtime.persistenceRoots.key}`,
    );
    lines.push(`  policy: ${runtime.disposition}; ${runtime.survivorPolicy}`);
    lines.push(
      `  lifecycle: ${runtime.lifecycle.state === "available" ? runtime.lifecycle.event : "unavailable"}`,
    );
  }
  lines.push(
    `host PTYs: ${inventory.host.state === "available" ? inventory.host.livePtyCount : inventory.host.refusalCode}`,
  );
  lines.push(`evidence: ${inventory.evidence.lifecycleLog}`);
  return `${lines.join("\n")}\n`;
}

function printRuntimeInventoryHelp() {
  process.stdout.write(`Usage: pnpm station:runtime-inventory [-- --state-dir /absolute/path] [--json]

Reads registered disposable runtime ownership evidence. It never signals, deletes,
repairs, starts, or stops Station processes.\n`);
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}
