import {
  parseStationHostConvergenceCommand,
  type StationHostConvergenceResult,
  type StationHostTargetBuild,
} from "@station/contracts";
import { openStationHostLifecycleSession } from "@station/host";
import {
  type ExecuteStationHostConvergenceInput,
  executeStationHostConvergence,
  type StationHostConvergencePorts,
} from "./executeStationHostConvergence.js";
import type { StationHostCommand } from "./hostProcess.js";
import { inspectStationHost } from "./inspectStationHost.js";
import { readStationHostEndpoint, readStationHostEvidence } from "./readStationHostEvidence.js";
import { startStationHostWithOwnershipProof } from "./startStationHostWithOwnershipProof.js";

export {
  type ExecuteStationHostConvergenceInput,
  executeStationHostConvergence,
  type StationHostConvergencePorts,
};

export type ConvergeStationHostOptions = {
  command: unknown;
  targetBuild: StationHostTargetBuild;
  socketPath: string;
  stateDir: string;
  hostCommand: StationHostCommand;
};

/**
 * COMPOSITION ROOT
 *
 * Contextually parses and snapshots exact authority before binding local adapters.
 */
export function convergeStationHost(
  options: ConvergeStationHostOptions,
  deps: Partial<StationHostConvergencePorts> = {},
): Promise<StationHostConvergenceResult> {
  const now = deps.now ?? Date.now;
  const command = parseStationHostConvergenceCommand(options.command, {
    targetBuild: options.targetBuild,
    socketPath: options.socketPath,
    nowMs: now(),
  });
  const input: ExecuteStationHostConvergenceInput = {
    command,
    stateDir: options.stateDir,
    hostCommand: [...options.hostCommand] as StationHostCommand,
    detached: process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1",
  };
  const probeEndpoint =
    deps.probeEndpoint ?? ((deadlineMs) => readStationHostEndpoint(command.socketPath, deadlineMs));
  const openSession =
    deps.openSession ??
    ((buildVersion, deadlineMs) =>
      openStationHostLifecycleSession({
        socketPath: command.socketPath,
        expectedBuildVersion: buildVersion,
        deadlineMs,
      }));
  return executeStationHostConvergence(input, {
    openSession,
    probeEndpoint,
    readEvidence:
      deps.readEvidence ??
      ((session, endpoint, deadlineMs) =>
        readStationHostEvidence({
          expectedEndpoint: endpoint,
          session,
          deadlineMs,
          probeEndpoint: (_path, deadline) => probeEndpoint(deadline),
        })),
    startTarget:
      deps.startTarget ?? ((startInput) => startStationHostWithOwnershipProof(startInput, { now })),
    inspectTarget:
      deps.inspectTarget ??
      ((buildVersion, deadlineMs) =>
        inspectStationHost(
          { socketPath: command.socketPath, expectedBuildVersion: buildVersion, deadlineMs },
          {
            probeEndpoint: (_path, deadline) => probeEndpoint(deadline),
            openSession: ({ expectedBuildVersion, deadlineMs: deadline }) =>
              openSession(expectedBuildVersion, deadline),
          },
        )),
    now,
  });
}
