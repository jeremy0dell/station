import { restartObserver, startObserver } from "@station/cli";
import type { ChildProcessLike } from "@station/cli/internal";
import type { SafeError } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../../tests/support/temp-projects";

/**
 * Surfacing guarantees for Observer-activation failures when a foreign-build Observer owns the
 * socket during `stn setup`:
 *
 *  1. A flattened or timed-out startup failure surfaces a separate typed cause and bounded,
 *     redacted child-owned boot evidence instead of interpolating either into the hint.
 *  2. A failed cross-build restart retains the incumbent build identity it tried to replace.
 *  3. The setup activation adapter wires the startup progress callback that startObserver
 *     supports (proven in setup-observer-activation.test.ts).
 */

const now = "2026-05-20T12:00:00.000Z";
const sourceBuildVersion = `0.0.0-pre-alpha.4+station.${"e".repeat(64)}`;
const compiledBuildVersion = `0.0.0-pre-alpha.14+station.${"d".repeat(64)}`;

const bootReason = "FATAL: socket owned by foreign build dbf7f368";

function fakeChild(overrides: Partial<ChildProcessLike> = {}): ChildProcessLike {
  return { pid: 1234, unref: () => undefined, ...overrides };
}

type ObserverStatusResult = Awaited<ReturnType<typeof startObserver>>;

function unhealthyError(result: ObserverStatusResult): SafeError {
  if (result.status === "running") {
    throw new Error("Expected an unhealthy result, got running.");
  }
  if (result.error === undefined) {
    throw new Error(`Expected a SafeError on status ${result.status}.`);
  }
  return result.error;
}

function unavailableClientFactory(message = "connect ENOENT observer.sock") {
  return () =>
    ({
      health: async () => {
        throw new Error(message);
      },
    }) as never;
}

describe("startup failures surface the boot failure evidence", () => {
  it("keeps the redacted spawn failure reason as a structured cause", async () => {
    const fixture = await createTempState();

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 200 },
      {
        buildVersion: compiledBuildVersion,
        spawnObserver: async (): Promise<ChildProcessLike> => {
          throw new Error(`spawn aborted: ${bootReason}`);
        },
        clientFactory: unavailableClientFactory(),
      },
    );

    const error = unhealthyError(result);
    expect(error.code).toBe("OBSERVER_START_FAILED");
    expect(error.message).toBe("Observer startup failed.");
    expect(error.hint).not.toContain(bootReason);
    expect(result).toMatchObject({
      cause: {
        code: "OBSERVER_STARTUP_CAUSE_ERROR",
        message: `spawn aborted: ${bootReason}`,
      },
    });
  });

  it("reads the child boot log when the boot wait fails without early exit", async () => {
    const fixture = await createTempState();
    const neverExits = new Promise<never>(() => undefined);
    const readBootLogTail = vi.fn(async () => bootReason);
    let killed = false;

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 60 },
      {
        buildVersion: compiledBuildVersion,
        spawnObserver: async (): Promise<ChildProcessLike> =>
          fakeChild({
            exited: neverExits,
            readBootLogTail,
            kill: () => {
              killed = true;
              return true;
            },
            disposeBootLog: async () => undefined,
          }),
        clientFactory: unavailableClientFactory(),
      },
    );

    const error = unhealthyError(result);
    expect(killed).toBe(true);
    expect(readBootLogTail).toHaveBeenCalled();
    expect(error.hint).not.toContain(bootReason);
    expect(result).toMatchObject({ startupEvidence: { bootLogTail: bootReason } });
  });

  it("control: reads the same boot log when the child exits early", async () => {
    const fixture = await createTempState();
    const readBootLogTail = vi.fn(async () => bootReason);

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 2_000 },
      {
        buildVersion: compiledBuildVersion,
        spawnObserver: async (): Promise<ChildProcessLike> =>
          fakeChild({
            exited: Promise.resolve({ type: "exit", code: 1, signal: null }),
            readBootLogTail,
            kill: () => true,
            disposeBootLog: async () => undefined,
          }),
        clientFactory: unavailableClientFactory(),
      },
    );

    // Identical evidence availability, opposite outcome: the early-exit path
    // is the only one that surfaces the boot reason.
    const error = unhealthyError(result);
    expect(error.code).toBe("OBSERVER_EXITED_ON_START");
    expect(readBootLogTail).toHaveBeenCalled();
    expect(error.hint).not.toContain(bootReason);
    expect(result).toMatchObject({ startupEvidence: { bootLogTail: bootReason } });
  });
});

describe("a failed cross-build restart retains the incumbent build context", () => {
  it("reports a failed higher-build handoff with the incumbent build it tried to replace", async () => {
    const fixture = await createTempState();
    let spawns = 0;
    let running = true;

    const result = await restartObserver(
      { config: fixture.config, timeoutMs: 200 },
      {
        buildVersion: compiledBuildVersion,
        spawnObserver: async (): Promise<ChildProcessLike> => {
          spawns += 1;
          throw new Error(`boot aborted: ${bootReason}`);
        },
        clientFactory: () =>
          ({
            health: async () => {
              if (!running) throw new Error("stopped");
              return {
                schemaVersion: "0.12.0",
                status: "healthy",
                pid: 4321,
                startedAt: now,
                version: sourceBuildVersion,
                socketPath: fixture.socketPath,
              };
            },
            stop: async () => {
              running = false;
              return { schemaVersion: "0.12.0", stopped: true, at: now };
            },
          }) as never,
      },
    );

    // The caller's build wins precedence, so a replacement child is attempted…
    expect(spawns).toBe(1);
    const error = unhealthyError(result);
    expect(error.code).toBe("OBSERVER_START_FAILED");
    // …and when that attempt fails, the error names the incumbent build that
    // owned the socket plus the redacted reason the replacement never booted.
    expect(error.hint).toContain("Restart was replacing incumbent 0.0.0-pre-alpha.4");
    expect(error.hint).toContain("pid 4321");
    expect(JSON.stringify(error)).not.toContain(bootReason);
    expect(result).toMatchObject({
      cause: { code: "OBSERVER_STARTUP_CAUSE_ERROR", message: `boot aborted: ${bootReason}` },
    });
  });

  it("control: the upfront refusal path surfaces both builds without attempting a start", async () => {
    const fixture = await createTempState();
    let spawns = 0;

    const result = await restartObserver(
      { config: fixture.config, timeoutMs: 200 },
      {
        buildVersion: sourceBuildVersion,
        spawnObserver: async (): Promise<ChildProcessLike> => {
          spawns += 1;
          return fakeChild();
        },
        clientFactory: () =>
          ({
            health: async () => ({
              schemaVersion: "0.12.0",
              status: "healthy",
              pid: 4321,
              startedAt: now,
              version: compiledBuildVersion,
              socketPath: fixture.socketPath,
            }),
            stop: async () => ({ schemaVersion: "0.12.0", stopped: true, at: now }),
          }) as never,
      },
    );

    // The good error exists — but only when no replacement is attempted.
    expect(spawns).toBe(0);
    const error = unhealthyError(result);
    expect(error.code).toBe("OBSERVER_HANDOFF_REFUSED");
    expect(error.hint).toContain("Running build");
    expect(error.hint).toContain("Requested build");
    expect(error.hint).toContain("cannot restart a newer Observer");
  });
});
