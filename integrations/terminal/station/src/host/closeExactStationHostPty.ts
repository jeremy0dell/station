import type { StationHostExactEvidence, StationHostTerminalLifetime } from "@station/contracts";
import { openStationHostLifecycleSession, type StationHostLifecycleSession } from "@station/host";
import { StationTerminalProviderError } from "../errors.js";
import {
  readStationHostEvidence,
  type StationHostEndpointProbe,
  stationHostEndpointsMatch,
  stationHostHealthMatches,
} from "./readStationHostEvidence.js";

export type CloseExactStationHostPtyOptions = {
  expectedHost: StationHostExactEvidence;
  expectedPty: StationHostTerminalLifetime;
  deadlineMs?: number;
};

type CloseExactStationHostPtyDeps = {
  openSession?: typeof openStationHostLifecycleSession;
  probeEndpoint?: StationHostEndpointProbe;
};

/**
 * ADAPTER
 *
 * Closes one proven Host PTY on the same non-reconnecting connection used to
 * revalidate its endpoint, build, and immutable lifetime before and after close.
 */
export async function closeExactStationHostPty(
  options: CloseExactStationHostPtyOptions,
  deps: CloseExactStationHostPtyDeps = {},
): Promise<{ status: "released" | "already-absent" }> {
  const deadlineMs = options.deadlineMs ?? Date.now() + 5_000;
  const open = deps.openSession ?? openStationHostLifecycleSession;
  let session: StationHostLifecycleSession | undefined;
  try {
    session = await open({
      socketPath: options.expectedHost.endpoint.socketPath,
      expectedBuildVersion: options.expectedHost.health.buildVersion,
      deadlineMs,
    });
    const before = await readStationHostEvidence({
      expectedEndpoint: options.expectedHost.endpoint,
      session,
      deadlineMs,
      ...(deps.probeEndpoint === undefined ? {} : { probeEndpoint: deps.probeEndpoint }),
    });
    assertSameHostLifetime(options.expectedHost, before);
    const current = before.terminals.find((candidate) =>
      samePtyLifetime(candidate, options.expectedPty),
    );
    if (current === undefined) {
      return { status: "already-absent" };
    }
    const closed = await session.close(options.expectedPty.ptyId);
    if (!closed.closed) {
      throw cleanupUncertain("Station Host refused to close the proven native PTY.");
    }
    const after = await readStationHostEvidence({
      expectedEndpoint: options.expectedHost.endpoint,
      session,
      deadlineMs,
      ...(deps.probeEndpoint === undefined ? {} : { probeEndpoint: deps.probeEndpoint }),
    });
    assertSameHostLifetime(options.expectedHost, after);
    if (after.terminals.some((candidate) => samePtyLifetime(candidate, options.expectedPty))) {
      throw cleanupUncertain("Station Host still reports the native PTY after close.");
    }
    return { status: "released" };
  } catch (cause) {
    if (cause instanceof StationTerminalProviderError) throw cause;
    throw cleanupUncertain("Could not prove exact native Host PTY cleanup.", cause);
  } finally {
    session?.dispose();
  }
}

function assertSameHostLifetime(
  expected: StationHostExactEvidence,
  actual: StationHostExactEvidence,
): void {
  if (
    !stationHostEndpointsMatch(expected.endpoint, actual.endpoint) ||
    !stationHostHealthMatches(expected.health, actual.health) ||
    expected.buildIdentity !== actual.buildIdentity
  ) {
    throw cleanupUncertain("Station Host lifetime changed during native PTY cleanup.");
  }
}

function samePtyLifetime(
  left: Pick<StationHostTerminalLifetime, "terminalTargetId" | "ptyId" | "ptyInstanceId">,
  right: Pick<StationHostTerminalLifetime, "terminalTargetId" | "ptyId" | "ptyInstanceId">,
): boolean {
  return (
    left.terminalTargetId === right.terminalTargetId &&
    left.ptyId === right.ptyId &&
    left.ptyInstanceId === right.ptyInstanceId
  );
}

function cleanupUncertain(message: string, cause?: unknown): StationTerminalProviderError {
  return new StationTerminalProviderError("TERMINAL_CLEANUP_UNCERTAIN", message, {
    ...(cause === undefined ? {} : { cause }),
    hint: "Inspect the retained native session and Station Host before removing its worktree.",
  });
}
