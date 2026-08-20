import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  ObserverHealth,
  RepairRuntimeOwnership,
  RepairTerminalGroup,
} from "@station/contracts";
import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  type HostHealthResult,
  type HostListEntry,
  type StationHostClient,
} from "@station/host";
import {
  createLocalObserverProcessEvidence,
  type ObserverDuplicateProcessEvidenceSource,
  type ObserverProcessEntry,
  observerProcessEntriesMatch,
  observerProcessIdentitiesMatch,
} from "@station/observer/internal";
import {
  probeUnixSocket,
  readUnixSocketHolderPids,
  type SocketIdentity,
  type UnixSocketProbe,
} from "@station/protocol";
import { z } from "zod";
import type { ObserverStatus } from "../../observerProcess.js";

export type RepairHostInspection = {
  ownership: RepairRuntimeOwnership;
  terminalGroups: RepairTerminalGroup[];
  refusalCode?: string;
};

/**
 * DRIVEN PORT
 *
 * Supplies read-only process, socket, Host, and terminal-topology evidence to repair inventory.
 * Evidence can describe candidates but never grants signal or close authority.
 */
export interface RepairLocalRuntimeEvidence {
  inspectObserver(input: {
    socketPath: string;
    status: ObserverStatus;
  }): Promise<RepairRuntimeOwnership>;
  inspectHost(input: {
    socketPath: string;
    stateDir: string;
    expectedHostCommand: readonly [string, ...string[]];
  }): Promise<RepairHostInspection>;
}

type ProcessTopology = {
  pid: number;
  processGroupId: number;
  sessionId: number;
  tty: string;
  startToken: string;
};

type ProcessCommandEvidence = {
  startToken: string;
  executablePath: string;
  argv: string[];
};

export type LocalRepairRuntimeEvidenceDeps = {
  probeSocket?: (socketPath: string) => Promise<UnixSocketProbe>;
  socketHolders?: (socketPath: string) => number[];
  observerEvidence?: ObserverDuplicateProcessEvidenceSource;
  hostClientFactory?: (socketPath: string, expectedBuildVersion?: string) => StationHostClient;
  readProcessCommand?: (
    pid: number,
    expectedArgv: readonly string[],
  ) => ProcessCommandEvidence | undefined;
  readProcessTopologies?: () => ProcessTopology[];
};

/**
 * ADAPTER
 *
 * Correlates fail-closed local socket ownership, exact daemon argv, Host list responses, and two
 * OS topology reads. Every returned verified terminal group remains tied to one socket lifetime.
 */
export function createLocalRepairRuntimeEvidence(
  deps: LocalRepairRuntimeEvidenceDeps = {},
): RepairLocalRuntimeEvidence {
  const probeSocket = deps.probeSocket ?? probeUnixSocket;
  const socketHolders = deps.socketHolders ?? readUnixSocketHolderPids;
  const observerEvidence = deps.observerEvidence ?? createLocalObserverProcessEvidence();
  const hostClientFactory =
    deps.hostClientFactory ??
    ((socketPath, expectedBuildVersion) =>
      createStationHostClient({
        socketPath,
        ...(expectedBuildVersion === undefined ? {} : { expectedBuildVersion }),
      }));
  const readProcessCommand = deps.readProcessCommand ?? readLocalProcessCommand;
  const readProcessTopologies = deps.readProcessTopologies ?? readLocalProcessTopologies;

  return {
    inspectObserver: (input) => inspectObserverOwnership(input, { probeSocket, observerEvidence }),
    inspectHost: (input) =>
      inspectHostRuntime(input, {
        probeSocket,
        socketHolders,
        hostClientFactory,
        readProcessCommand,
        readProcessTopologies,
      }),
  };
}

async function inspectObserverOwnership(
  input: { socketPath: string; status: ObserverStatus },
  deps: {
    probeSocket: (socketPath: string) => Promise<UnixSocketProbe>;
    observerEvidence: ObserverDuplicateProcessEvidenceSource;
  },
): Promise<RepairRuntimeOwnership> {
  const status = input.status;
  if (status.status !== "running") {
    if (status.status === "stopped") {
      return emptyOwnership("observer", "absent", input.socketPath);
    }
    if (status.status === "stale") return emptyOwnership("observer", "stale", input.socketPath);
    return refusedOwnership("observer", input.socketPath, "OBSERVER_UNAVAILABLE");
  }

  const health = status.health;
  if (
    health.pid === undefined ||
    health.startedAt === undefined ||
    health.version === undefined ||
    health.socketPath === undefined
  ) {
    return refusedOwnership("observer", input.socketPath, "OBSERVER_IDENTITY_INCOMPLETE");
  }
  if (health.socketPath !== input.socketPath) {
    return refusedOwnership("observer", input.socketPath, "OBSERVER_IDENTITY_CHANGED");
  }
  const exactHealth = {
    ...health,
    pid: health.pid,
    startedAt: health.startedAt,
    version: health.version,
  };
  try {
    const firstProbe = await deps.probeSocket(input.socketPath);
    if (firstProbe.status !== "listening") {
      return refusedOwnership("observer", input.socketPath, "OBSERVER_SOCKET_CHANGED");
    }
    const holders = sortedNumbers(deps.observerEvidence.socketHolders(input.socketPath));
    const firstIdentity = await deps.observerEvidence.readProcessIdentity(input.socketPath);
    const processEntry = exactObserverProcess(
      deps.observerEvidence,
      exactHealth,
      firstIdentity,
      input.socketPath,
    );
    if (processEntry === undefined) {
      return refusedOwnership("observer", input.socketPath, "OBSERVER_IDENTITY_CHANGED", holders);
    }
    const firstStartToken = deps.observerEvidence.processStartToken(processEntry.pid);
    const secondProcess = deps.observerEvidence.readObserverProcess(processEntry.pid);
    const secondStartToken = deps.observerEvidence.processStartToken(processEntry.pid);
    const secondIdentity = await deps.observerEvidence.readProcessIdentity(input.socketPath);
    const secondHolders = sortedNumbers(deps.observerEvidence.socketHolders(input.socketPath));
    const secondProbe = await deps.probeSocket(input.socketPath);
    if (
      holders.length !== 1 ||
      holders[0] !== processEntry.pid ||
      !sameNumbers(holders, secondHolders) ||
      firstStartToken === undefined ||
      firstStartToken !== processEntry.startToken ||
      secondStartToken !== firstStartToken ||
      firstIdentity === undefined ||
      secondIdentity === undefined ||
      !observerProcessIdentitiesMatch(firstIdentity, secondIdentity) ||
      secondProcess === undefined ||
      !observerProcessEntriesMatch(processEntry, secondProcess) ||
      secondProbe.status !== "listening" ||
      !sameSocketIdentity(firstProbe.identity, secondProbe.identity)
    ) {
      return refusedOwnership("observer", input.socketPath, "OBSERVER_IDENTITY_CHANGED", holders);
    }
    return {
      component: "observer",
      status: "verified",
      socketPath: input.socketPath,
      socketIdentity: repairSocketIdentity(firstProbe.identity),
      holderPids: holders,
      process: {
        pid: processEntry.pid,
        startToken: processEntry.startToken,
        executablePath: processEntry.executablePath,
        argv: processEntry.argv,
      },
      buildVersion: health.version,
    };
  } catch {
    return refusedOwnership("observer", input.socketPath, "OBSERVER_EVIDENCE_UNAVAILABLE");
  }
}

function exactObserverProcess(
  evidence: ObserverDuplicateProcessEvidenceSource,
  health: ObserverHealth & { pid: number; startedAt: string; version: string },
  identity: Awaited<ReturnType<ObserverDuplicateProcessEvidenceSource["readProcessIdentity"]>>,
  socketPath: string,
): ObserverProcessEntry | undefined {
  const entry = evidence.readObserverProcess(health.pid);
  if (
    identity === undefined ||
    identity.pid !== health.pid ||
    identity.version !== health.version ||
    identity.socketPath !== socketPath ||
    entry === undefined ||
    entry.socketPath !== socketPath ||
    entry.buildVersion !== health.version ||
    entry.pid !== identity.pid ||
    entry.startToken !== identity.osStartTime ||
    entry.processToken !== identity.processToken
  ) {
    return undefined;
  }
  return entry;
}

async function inspectHostRuntime(
  input: {
    socketPath: string;
    stateDir: string;
    expectedHostCommand: readonly [string, ...string[]];
  },
  deps: {
    probeSocket: (socketPath: string) => Promise<UnixSocketProbe>;
    socketHolders: (socketPath: string) => number[];
    hostClientFactory: (socketPath: string, expectedBuildVersion?: string) => StationHostClient;
    readProcessCommand: (
      pid: number,
      expectedArgv: readonly string[],
    ) => ProcessCommandEvidence | undefined;
    readProcessTopologies: () => ProcessTopology[];
  },
): Promise<RepairHostInspection> {
  const firstProbe = await deps.probeSocket(input.socketPath);
  if (firstProbe.status === "absent") {
    return { ownership: emptyOwnership("host", "absent", input.socketPath), terminalGroups: [] };
  }
  if (firstProbe.status === "stale") {
    return { ownership: emptyOwnership("host", "stale", input.socketPath), terminalGroups: [] };
  }
  if (firstProbe.status !== "listening") {
    return hostRefusal(input.socketPath, "HOST_SOCKET_UNAVAILABLE");
  }

  let client: StationHostClient | undefined;
  let inventoryClient: StationHostClient | undefined;
  try {
    const holders = sortedNumbers(deps.socketHolders(input.socketPath));
    if (holders.length !== 1)
      return hostRefusal(input.socketPath, "HOST_HOLDER_AMBIGUOUS", holders);
    const hostPid = holders[0] as number;
    const expectedArgv = [
      ...input.expectedHostCommand,
      "--socket",
      input.socketPath,
      "--state-dir",
      input.stateDir,
    ];
    const firstProcess = deps.readProcessCommand(hostPid, expectedArgv);
    if (
      firstProcess === undefined ||
      !sameArgv(firstProcess.argv, expectedArgv) ||
      !matchesExpectedExecutable(firstProcess.executablePath, expectedArgv[0] as string)
    ) {
      return hostRefusal(input.socketPath, "HOST_PROCESS_PROVENANCE_UNVERIFIED", holders);
    }

    client = deps.hostClientFactory(input.socketPath);
    const health = await client.health();
    const hostBuildVersion = health.buildVersion;
    if (health.protocolVersion !== HOST_PROTOCOL_VERSION || hostBuildVersion === undefined) {
      return hostRefusal(input.socketPath, "HOST_PROTOCOL_INCOMPATIBLE", holders, health);
    }
    inventoryClient = deps.hostClientFactory(input.socketPath, hostBuildVersion);
    const firstPtys = sortedPtys(await inventoryClient.list());
    const firstTopologies = deps.readProcessTopologies();
    const secondTopologies = deps.readProcessTopologies();
    const secondPtys = sortedPtys(await inventoryClient.list());
    const secondProcess = deps.readProcessCommand(hostPid, expectedArgv);
    const secondHolders = sortedNumbers(deps.socketHolders(input.socketPath));
    const secondProbe = await deps.probeSocket(input.socketPath);
    if (
      secondProbe.status !== "listening" ||
      !sameSocketIdentity(firstProbe.identity, secondProbe.identity) ||
      !sameNumbers(holders, secondHolders) ||
      secondProcess === undefined ||
      !sameProcessCommandEvidence(firstProcess, secondProcess) ||
      !samePtys(firstPtys, secondPtys)
    ) {
      return hostRefusal(input.socketPath, "HOST_INVENTORY_CHANGED", holders, health);
    }

    const hostProcess: RepairTerminalGroup["hostProcess"] = {
      pid: hostPid,
      startToken: firstProcess.startToken,
      executablePath: firstProcess.executablePath,
      argv: firstProcess.argv,
    };
    const socketIdentity = repairSocketIdentity(firstProbe.identity);
    const groups = firstPtys
      .map((pty) =>
        terminalGroup(pty, firstTopologies, secondTopologies, socketIdentity, hostProcess, {
          ...health,
          buildVersion: hostBuildVersion,
        }),
      )
      .sort((left, right) => left.targetKey.localeCompare(right.targetKey));
    return {
      ownership: {
        component: "host",
        status: "verified",
        socketPath: input.socketPath,
        socketIdentity,
        holderPids: holders,
        process: hostProcess,
        buildVersion: health.buildVersion,
        protocolVersion: health.protocolVersion,
      },
      terminalGroups: groups,
      ...(groups.some((group) => group.disposition === "refused")
        ? { refusalCode: "HOST_TERMINAL_TOPOLOGY_UNVERIFIED" }
        : {}),
    };
  } catch {
    return hostRefusal(input.socketPath, "HOST_EVIDENCE_UNAVAILABLE");
  } finally {
    inventoryClient?.dispose();
    client?.dispose();
  }
}

function terminalGroup(
  pty: HostListEntry,
  firstTopologies: readonly ProcessTopology[],
  secondTopologies: readonly ProcessTopology[],
  socketIdentity: RepairTerminalGroup["hostSocketIdentity"],
  hostProcess: RepairTerminalGroup["hostProcess"],
  health: HostHealthResult & { buildVersion: string },
): RepairTerminalGroup {
  const firstChild = firstTopologies.find((entry) => entry.pid === pty.pid);
  const secondChild = secondTopologies.find((entry) => entry.pid === pty.pid);
  const fallback = firstChild ?? secondChild ?? unavailableTopology(pty.pid);
  const firstMembers = firstTopologies
    .filter((entry) => entry.processGroupId === fallback.processGroupId)
    .sort((left, right) => left.pid - right.pid);
  const secondMembers = secondTopologies
    .filter((entry) => entry.processGroupId === fallback.processGroupId)
    .sort((left, right) => left.pid - right.pid);
  const leader = firstMembers.find((entry) => entry.pid === fallback.processGroupId);
  const topologyStable =
    pty.alive &&
    firstChild !== undefined &&
    secondChild !== undefined &&
    sameTopology(firstChild, secondChild) &&
    leader !== undefined &&
    firstMembers.length > 0 &&
    firstMembers.every(
      (member) =>
        member.sessionId === firstChild.sessionId &&
        member.tty === firstChild.tty &&
        member.processGroupId === firstChild.processGroupId,
    ) &&
    sameTopologies(firstMembers, secondMembers);
  const targetKey = runtimeTargetKey({
    socketIdentity,
    hostPid: hostProcess.pid,
    hostStartToken: hostProcess.startToken,
    ptyId: pty.ptyId,
    ptyInstanceId: pty.ptyInstanceId,
    terminalTargetId: pty.terminalTargetId,
    childPid: pty.pid,
    processGroupId: fallback.processGroupId,
    leaderStartToken: leader?.startToken ?? "unavailable",
  });
  const result: RepairTerminalGroup = {
    targetKey,
    disposition: pty.kind === "aux" ? "non-recoverable" : topologyStable ? "verified" : "refused",
    kind: pty.kind,
    hostSocketIdentity: socketIdentity,
    hostProcess,
    hostBuildVersion: health.buildVersion,
    hostProtocolVersion: health.protocolVersion,
    ptyId: pty.ptyId,
    ptyInstanceId: pty.ptyInstanceId,
    terminalTargetId: pty.terminalTargetId,
    projectId: pty.projectId,
    worktreeId: pty.worktreeId,
    stationSessionId: pty.sessionId,
    harnessProvider: pty.harnessProvider,
    childPid: pty.pid,
    processGroupId: fallback.processGroupId,
    terminalSessionId: fallback.sessionId,
    tty: fallback.tty,
    leaderStartToken: leader?.startToken ?? "unavailable",
    members: (firstMembers.length > 0 ? firstMembers : [fallback]).map((member) => ({
      pid: member.pid,
      processGroupId: member.processGroupId,
      sessionId: member.sessionId,
      tty: member.tty,
      startToken: member.startToken,
    })),
  };
  if (!topologyStable && pty.kind !== "aux") result.refusalCode = "PROCESS_TOPOLOGY_UNVERIFIED";
  return result;
}

function unavailableTopology(pid: number): ProcessTopology {
  return {
    pid,
    processGroupId: pid,
    sessionId: pid,
    tty: "unavailable",
    startToken: "unavailable",
  };
}

function runtimeTargetKey(value: object): string {
  return `runtime:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
}

function hostRefusal(
  socketPath: string,
  refusalCode: string,
  holderPids: number[] = [],
  health?: HostHealthResult,
): RepairHostInspection {
  return {
    ownership: refusedOwnership(
      "host",
      socketPath,
      refusalCode,
      holderPids,
      health?.buildVersion,
      health?.protocolVersion,
    ),
    terminalGroups: [],
    refusalCode,
  };
}

function emptyOwnership(
  component: "observer" | "host",
  status: "absent" | "stale",
  socketPath: string,
): RepairRuntimeOwnership {
  return { component, status, socketPath, holderPids: [] };
}

function refusedOwnership(
  component: "observer" | "host",
  socketPath: string,
  refusalCode: string,
  holderPids: number[] = [],
  buildVersion?: string,
  protocolVersion?: number,
): RepairRuntimeOwnership {
  const ownership: RepairRuntimeOwnership = {
    component,
    status: "uncertain",
    socketPath,
    holderPids: sortedNumbers(holderPids),
    refusalCode,
  };
  if (buildVersion !== undefined) ownership.buildVersion = buildVersion;
  if (protocolVersion !== undefined) ownership.protocolVersion = protocolVersion;
  return ownership;
}

function repairSocketIdentity(identity: SocketIdentity) {
  return { inode: identity.ino.toString(), birthtimeNs: identity.birthtimeNs.toString() };
}

function readLocalProcessCommand(
  pid: number,
  expectedArgv: readonly string[],
): ProcessCommandEvidence | undefined {
  const expectedExecutable = expectedArgv[0];
  if (expectedExecutable === undefined || !isAbsolute(expectedExecutable)) return undefined;
  const output = execFileSync(
    psPath(),
    ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="],
    {
      encoding: "utf8",
    },
  ).trim();
  const match = /^(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/u.exec(output);
  if (match === null) return undefined;
  const argv = exactProcessArgv(pid, expectedArgv, match[2] as string);
  const executablePath = exactProcessExecutable(pid, expectedExecutable);
  if (argv === undefined || executablePath === undefined) return undefined;
  return { startToken: match[1] as string, executablePath, argv };
}

function exactProcessArgv(
  pid: number,
  expectedArgv: readonly string[],
  flattenedCommand: string,
): string[] | undefined {
  if (process.platform !== "darwin") {
    const commandLine = readFileSync(`/proc/${pid}/cmdline`);
    if (commandLine.length === 0 || commandLine[commandLine.length - 1] !== 0) return undefined;
    const argv = commandLine.subarray(0, -1).toString("utf8").split("\0");
    return sameArgv(argv, expectedArgv) ? argv : undefined;
  }
  if (expectedArgv.some((value) => /\s/u.test(value))) return undefined;
  return flattenedCommand === expectedArgv.join(" ") ? [...expectedArgv] : undefined;
}

function exactProcessExecutable(pid: number, expectedPath: string): string | undefined {
  const resolved = realpathSync(expectedPath);
  if (process.platform !== "darwin") {
    return realpathSync(readlinkSync(`/proc/${pid}/exe`)) === resolved ? resolved : undefined;
  }
  const expected = statSync(resolved, { bigint: true });
  const output = execFileSync(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(pid), "-d", "txt", "-F0pfnDi"],
    { encoding: "utf8" },
  );
  return lsofTextImageMatches(output, pid, resolved, expected.dev, expected.ino)
    ? resolved
    : undefined;
}

function lsofTextImageMatches(
  output: string,
  pid: number,
  path: string,
  device: bigint,
  inode: bigint,
): boolean {
  if (!output.endsWith("\n")) return false;
  const lines = output.slice(0, -1).split("\n");
  if (lines[0] !== `p${pid}\0`) return false;
  return lines.slice(1).some((line) => {
    if (!line.endsWith("\0")) return false;
    const fields = line.slice(0, -1).split("\0");
    if (fields.length !== 4 || fields[0] !== "ftxt") return false;
    const deviceField = fields[1];
    const inodeField = fields[2];
    const pathField = fields[3];
    if (
      deviceField === undefined ||
      !/^D0x[0-9a-f]+$/iu.test(deviceField) ||
      inodeField === undefined ||
      !/^i[1-9]\d*$/u.test(inodeField) ||
      pathField?.startsWith("n") !== true
    ) {
      return false;
    }
    return (
      BigInt(deviceField.slice(1)) === device &&
      BigInt(inodeField.slice(1)) === inode &&
      realpathSync(pathField.slice(1)) === path
    );
  });
}

function readLocalProcessTopologies(): ProcessTopology[] {
  const output = execFileSync(
    psPath(),
    ["-axww", "-o", "pid=", "-o", "pgid=", "-o", "sid=", "-o", "tty=", "-o", "lstart="],
    { encoding: "utf8" },
  );
  return parseProcessTopologies(output);
}

export function parseProcessTopologies(output: string): ProcessTopology[] {
  const schema = z
    .string()
    .regex(/^\s*\d+\s+\d+\s+\d+\s+\S+\s+\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4}\s*$/u);
  const values: ProcessTopology[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    if (!schema.safeParse(line).success) throw new Error("Process topology output was malformed.");
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (match === null) throw new Error("Process topology output was malformed.");
    values.push({
      pid: Number(match[1]),
      processGroupId: Number(match[2]),
      sessionId: Number(match[3]),
      tty: match[4] as string,
      startToken: match[5] as string,
    });
  }
  return values.sort((left, right) => left.pid - right.pid);
}

function psPath(): string {
  return process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
}

function sortedPtys(ptys: readonly HostListEntry[]): HostListEntry[] {
  return [...ptys].sort(
    (left, right) =>
      left.terminalTargetId.localeCompare(right.terminalTargetId) ||
      left.ptyId.localeCompare(right.ptyId),
  );
}

function samePtys(left: readonly HostListEntry[], right: readonly HostListEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSocketIdentity(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function sortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameProcessCommandEvidence(
  left: ProcessCommandEvidence,
  right: ProcessCommandEvidence,
): boolean {
  return (
    left.startToken === right.startToken &&
    left.executablePath === right.executablePath &&
    sameArgv(left.argv, right.argv)
  );
}

function matchesExpectedExecutable(actualPath: string, expectedPath: string): boolean {
  if (!isAbsolute(expectedPath)) return actualPath === expectedPath;
  return actualPath === realpathSync(expectedPath);
}

function sameTopology(left: ProcessTopology, right: ProcessTopology): boolean {
  return (
    left.pid === right.pid &&
    left.processGroupId === right.processGroupId &&
    left.sessionId === right.sessionId &&
    left.tty === right.tty &&
    left.startToken === right.startToken
  );
}

function sameTopologies(
  left: readonly ProcessTopology[],
  right: readonly ProcessTopology[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => sameTopology(value, right[index] as ProcessTopology))
  );
}
