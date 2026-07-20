import { access, chmod, mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import type {
  ObserverHealth,
  ProviderHookEvent,
  ProviderHookPayloadSummary,
  ProviderHookReceipt,
  SafeError,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { listenUnixSocket } from "@station/protocol";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../tests/support/temp-projects";
import { deliverProviderHookWithSpooling } from "../../src/ingress/deliveryPolicy.js";

const now = "2026-05-20T12:00:00.000Z";
const buildVersion = `1.2.3+station.${"c".repeat(64)}`;
const incumbentBuildVersion = `1.2.3+station.${"a".repeat(64)}`;
const replacementBuildVersion = `1.2.3+station.${"b".repeat(64)}`;
const crossVersionReplacement = `2.0.0+station.${"d".repeat(64)}`;

describe("provider hook delivery policy", () => {
  it("forwards the finalized observer command unchanged to auto-start", async () => {
    const fixture = await createTempState();
    const state = { running: false, spawnCount: 0, spooled: 0 };
    const observerCommand = ["/opt/station/stn", "__observer"] as const;
    let observedCommand: readonly string[] | undefined;
    const deps = {
      buildVersion,
      clock: { now: () => new Date(now) },
      clientFactory: () =>
        ({
          health: async (): Promise<ObserverHealth> => {
            if (!state.running) throw new Error("observer offline");
            return healthyObserver(fixture);
          },
        }) as never,
      spawnObserver: async (input: { observerCommand?: readonly string[] }) => {
        state.spawnCount += 1;
        observedCommand = input.observerCommand;
        state.running = true;
        return { pid: 12345, unref: () => undefined };
      },
    };

    await expect(
      deliverProviderHookWithSpooling(
        deliveryInput(fixture, "hook_finalized_command", state, deps, { observerCommand }),
      ),
    ).resolves.toMatchObject({ status: "ingested" });
    expect(observedCommand).toBe(observerCommand);
  });

  it("cancels a queued hook-started child after attaching to an incumbent", async () => {
    const fixture = await createTempState();
    const state = { running: false, spawnCount: 0, spooled: 0 };
    let childKills = 0;
    const deps = {
      buildVersion,
      clock: { now: () => new Date(now) },
      clientFactory: () =>
        ({
          health: async (): Promise<ObserverHealth> => {
            if (!state.running) throw new Error("observer offline");
            return { ...healthyObserver(fixture), pid: 9876 };
          },
        }) as never,
      spawnObserver: async () => {
        state.spawnCount += 1;
        state.running = true;
        return {
          pid: 12345,
          unref: () => undefined,
          kill: () => {
            childKills += 1;
            return true;
          },
        };
      },
    };

    await expect(
      deliverProviderHookWithSpooling(deliveryInput(fixture, "hook_losing_child", state, deps)),
    ).resolves.toMatchObject({ status: "ingested" });
    expect(childKills).toBe(1);
  });

  it("cancels a queued hook-started child when compatible health omits pid", async () => {
    const fixture = await createTempState();
    const state = { running: false, spawnCount: 0, spooled: 0 };
    const { pid: _pid, ...healthWithoutPid } = healthyObserver(fixture);
    let childKills = 0;
    const deps = {
      buildVersion,
      clientFactory: () =>
        ({
          health: async () => {
            if (!state.running) throw new Error("observer offline");
            return healthWithoutPid;
          },
        }) as never,
      spawnObserver: async () => {
        state.spawnCount += 1;
        state.running = true;
        return {
          pid: 12345,
          unref: () => undefined,
          kill: () => {
            childKills += 1;
            return true;
          },
        };
      },
    };

    await expect(
      deliverProviderHookWithSpooling(deliveryInput(fixture, "hook_legacy_pid", state, deps)),
    ).resolves.toMatchObject({ status: "ingested" });
    expect(childKills).toBe(1);
  });

  it("serializes concurrent observer auto-start attempts across hook senders", async () => {
    const fixture = await createTempState();
    const state = { running: false, spawnCount: 0, spooled: 0 };
    const gate = deferred();
    const deps = {
      buildVersion,
      clock: { now: () => new Date(now) },
      clientFactory: () =>
        ({
          health: async (): Promise<ObserverHealth> => {
            if (!state.running) throw new Error("observer offline");
            return healthyObserver(fixture);
          },
        }) as never,
      spawnObserver: async () => {
        state.spawnCount += 1;
        await gate.promise;
        state.running = true;
        return { pid: 12345, unref: () => undefined };
      },
    };

    const first = deliverProviderHookWithSpooling(
      deliveryInput(fixture, "hook_concurrent_1", state, deps),
    );
    const second = deliverProviderHookWithSpooling(
      deliveryInput(fixture, "hook_concurrent_2", state, deps),
    );
    await waitFor(async () => state.spawnCount === 1);
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ hookId: "hook_concurrent_1", status: "ingested" }),
      expect.objectContaining({ hookId: "hook_concurrent_2", status: "ingested" }),
    ]);
    expect(state.spawnCount).toBe(1);
    expect(state.spooled).toBe(0);
  });

  it("cleans stale auto-start locks before starting the observer", async () => {
    const fixture = await createTempState();
    const lockDir = join(fixture.stateDir, "run", "hook-autostart.lock");
    await mkdir(lockDir, { recursive: true });
    await utimes(
      lockDir,
      new Date("2000-01-01T00:00:00.000Z"),
      new Date("2000-01-01T00:00:00.000Z"),
    );
    const state = { running: false, spawnCount: 0, spooled: 0 };
    const deps = {
      buildVersion,
      clock: { now: () => new Date(now) },
      clientFactory: () =>
        ({
          health: async (): Promise<ObserverHealth> => {
            if (!state.running) throw new Error("observer offline");
            return healthyObserver(fixture);
          },
        }) as never,
      spawnObserver: async () => {
        state.spawnCount += 1;
        state.running = true;
        return { pid: 12345, unref: () => undefined };
      },
    };

    await expect(
      deliverProviderHookWithSpooling(deliveryInput(fixture, "hook_stale_lock", state, deps)),
    ).resolves.toMatchObject({ hookId: "hook_stale_lock", status: "ingested" });
    expect(state.spawnCount).toBe(1);
    expect(state.spooled).toBe(0);
  });

  it("spools when another auto-start owner never produces a healthy observer", async () => {
    const fixture = await createTempState();
    const lockDir = join(fixture.stateDir, "run", "hook-autostart.lock");
    await mkdir(lockDir, { recursive: true });
    const state = { running: false, spawnCount: 0, spooled: 0 };
    const deps = {
      buildVersion,
      clock: { now: () => new Date(now) },
      clientFactory: () =>
        ({
          health: async () => {
            throw new Error("observer offline");
          },
        }) as never,
      spawnObserver: async () => {
        state.spawnCount += 1;
        return { pid: 12345, unref: () => undefined };
      },
    };

    await expect(
      deliverProviderHookWithSpooling(
        deliveryInput(fixture, "hook_contended_timeout", state, deps, {
          startupTimeoutMs: 50,
        }),
      ),
    ).resolves.toMatchObject({
      hookId: "hook_contended_timeout",
      status: "spooled",
    });
    expect(state.spawnCount).toBe(0);
    expect(state.spooled).toBe(1);
  });

  it("shares one startup deadline across preflight, repeated status, and convergence", async () => {
    const fixture = await createTempState();
    const state = { running: false, spawnCount: 0, spooled: 0 };
    let healthCalls = 0;
    const requestTimeouts: number[] = [];
    const startupTimeoutMs = 80;
    const deps = {
      buildVersion,
      clientFactory: (_socketPath: string, options?: { timeoutMs: number }) =>
        ({
          health: async () => {
            healthCalls += 1;
            const requestTimeoutMs = options?.timeoutMs ?? startupTimeoutMs;
            requestTimeouts.push(requestTimeoutMs);
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, requestTimeoutMs)));
            throw new Error("observer offline");
          },
        }) as never,
      spawnObserver: async () => {
        state.spawnCount += 1;
        return { pid: 12345, unref: () => undefined };
      },
    };

    const startedAt = Date.now();
    await expect(
      deliverProviderHookWithSpooling(
        deliveryInput(fixture, "hook_total_deadline", state, deps, { startupTimeoutMs }),
      ),
    ).resolves.toMatchObject({ status: "spooled" });
    const elapsedMs = Date.now() - startedAt;
    const callsAtTimeout = healthCalls;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(healthCalls).toBe(callsAtTimeout);
    expect(healthCalls).toBeGreaterThanOrEqual(2);
    expect(requestTimeouts[1]).toBeLessThan(requestTimeouts[0] ?? 0);
    expect(state.spawnCount).toBeLessThanOrEqual(1);
    expect(elapsedMs).toBeLessThan(startupTimeoutMs * 2);
  });

  it("does not deliver to a lower build until its replacement is healthy", async () => {
    const fixture = await createTempState();
    const state = { running: true, spawnCount: 0, spooled: 0 };
    let runningVersion = "1.0.0";
    let deliveries = 0;
    const deps = {
      buildVersion: crossVersionReplacement,
      clientFactory: () =>
        ({
          health: async () => healthyObserver(fixture, 12345, runningVersion),
        }) as never,
      spawnObserver: async () => {
        expect(deliveries).toBe(0);
        state.spawnCount += 1;
        runningVersion = crossVersionReplacement;
        return { pid: 12345, unref: () => undefined };
      },
    };
    const input = deliveryInput(fixture, "hook_replacement", state, deps);
    input.deliver = async () => {
      deliveries += 1;
      return { receipt: ingestedReceipt(input.event) };
    };

    await expect(deliverProviderHookWithSpooling(input)).resolves.toMatchObject({
      status: "ingested",
    });
    expect(state.spawnCount).toBe(1);
    expect(deliveries).toBe(1);
    expect(state.spooled).toBe(0);
  });

  it("rejects instead of spooling when same-version replacement fails", async () => {
    const fixture = await createTempState();
    const state = { running: true, spawnCount: 0, spooled: 0 };
    let deliveries = 0;
    let healthCalls = 0;
    const deps = {
      buildVersion: replacementBuildVersion,
      clientFactory: () =>
        ({
          health: async () => {
            healthCalls += 1;
            if (healthCalls <= 2) {
              return healthyObserver(fixture, 12345, incumbentBuildVersion);
            }
            return { schemaVersion: STATION_SCHEMA_VERSION, status: "healthy" };
          },
        }) as never,
      spawnObserver: async () => {
        state.spawnCount += 1;
        return { pid: 5678, unref: () => undefined };
      },
    };
    const input = deliveryInput(fixture, "hook_handoff_refused", state, deps);
    input.deliver = async () => {
      deliveries += 1;
      return { receipt: ingestedReceipt(input.event) };
    };

    await expect(deliverProviderHookWithSpooling(input)).resolves.toMatchObject({
      accepted: false,
      status: "rejected",
      error: { code: "OBSERVER_HANDOFF_REFUSED" },
    });
    expect(state.spawnCount).toBe(1);
    expect(deliveries).toBe(0);
    expect(state.spooled).toBe(0);
  });

  it("rejects protocol mismatch without spawning or spooling", async () => {
    const fixture = await createTempState();
    const state = { running: true, spawnCount: 0, spooled: 0 };
    let deliveries = 0;
    const mismatch: SafeError = {
      tag: "ProtocolSchemaError",
      code: "PROTOCOL_SCHEMA_MISMATCH",
      message: "Observer protocol schema is incompatible.",
    };
    const deps = {
      buildVersion,
      clientFactory: () =>
        ({
          health: async () => {
            throw mismatch;
          },
        }) as never,
      spawnObserver: async () => {
        state.spawnCount += 1;
        return { pid: 12345, unref: () => undefined };
      },
    };
    const input = deliveryInput(fixture, "hook_schema_mismatch", state, deps);
    input.deliver = async () => {
      deliveries += 1;
      return { receipt: ingestedReceipt(input.event) };
    };

    await expect(deliverProviderHookWithSpooling(input)).resolves.toMatchObject({
      accepted: false,
      status: "rejected",
      error: { code: "PROTOCOL_SCHEMA_MISMATCH" },
    });
    expect(state.spawnCount).toBe(0);
    expect(deliveries).toBe(0);
    expect(state.spooled).toBe(0);
  });

  it("spools inaccessible ownership without delivery, spawn, or auto-start lock mutation", async () => {
    const fixture = await createTempState();
    const server = await listenUnixSocket({
      socketPath: fixture.socketPath,
      onConnection: () => undefined,
    });
    const state = { running: false, spawnCount: 0, spooled: 0 };
    const spawnObserver = vi.fn(async () => {
      state.spawnCount += 1;
      return { pid: 12345, unref: () => undefined };
    });
    const clientFactory = vi.fn(() => {
      throw new Error("inaccessible ownership must not create a client");
    });
    const input = deliveryInput(fixture, "hook_inaccessible", state, {
      buildVersion,
      spawnObserver,
      clientFactory,
    });
    input.deliver = vi.fn(async () => ({ receipt: ingestedReceipt(input.event) }));
    const lockDir = join(fixture.stateDir, "run", "hook-autostart.lock");
    try {
      await chmod(fixture.socketPath, 0o000);
      await expect(deliverProviderHookWithSpooling(input)).resolves.toMatchObject({
        hookId: "hook_inaccessible",
        provider: input.event.provider,
        event: input.event.event,
        accepted: true,
        status: "spooled",
        error: { code: "OBSERVER_SOCKET_INACCESSIBLE" },
      });
      expect(input.deliver).not.toHaveBeenCalled();
      expect(spawnObserver).not.toHaveBeenCalled();
      expect(clientFactory).not.toHaveBeenCalled();
      expect(state.spooled).toBe(1);
      await expect(access(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(fixture.socketPath, 0o600);
      await server.close();
    }
  });

  it("rejects without cross-build delivery or spooling when auto-start is disabled", async () => {
    const fixture = await createTempState();
    const state = { running: true, spawnCount: 0, spooled: 0 };
    let deliveries = 0;
    const deps = {
      buildVersion: "2.0.0",
      clientFactory: () =>
        ({
          health: async () => healthyObserver(fixture, 12345, "1.0.0"),
        }) as never,
    };
    const input = deliveryInput(fixture, "hook_no_autostart", state, deps);
    input.autoStart = false;
    input.deliver = async () => {
      deliveries += 1;
      return { receipt: ingestedReceipt(input.event) };
    };

    await expect(deliverProviderHookWithSpooling(input)).resolves.toMatchObject({
      accepted: false,
      status: "rejected",
      error: { code: "OBSERVER_HANDOFF_REFUSED" },
    });
    expect(deliveries).toBe(0);
    expect(state.spooled).toBe(0);
  });

  it("rejects legacy health without delivering, spawning, or spooling", async () => {
    const fixture = await createTempState();
    const state = { running: true, spawnCount: 0, spooled: 0 };
    let deliveries = 0;
    const deps = {
      buildVersion,
      clientFactory: () =>
        ({
          health: async () => ({ schemaVersion: STATION_SCHEMA_VERSION, status: "healthy" }),
        }) as never,
      spawnObserver: async () => {
        state.spawnCount += 1;
        return { pid: 12345, unref: () => undefined };
      },
    };
    const input = deliveryInput(fixture, "hook_legacy_health", state, deps);
    input.deliver = async () => {
      deliveries += 1;
      return { receipt: ingestedReceipt(input.event) };
    };

    await expect(deliverProviderHookWithSpooling(input)).resolves.toMatchObject({
      accepted: false,
      status: "rejected",
      error: { code: "OBSERVER_HANDOFF_REFUSED" },
    });
    expect(deliveries).toBe(0);
    expect(state.spawnCount).toBe(0);
    expect(state.spooled).toBe(0);
  });

  it("rejects a post-readiness build mismatch without spooling", async () => {
    const fixture = await createTempState();
    const state = { running: true, spawnCount: 0, spooled: 0 };
    const deps = {
      buildVersion,
      clientFactory: () =>
        ({
          health: async () => healthyObserver(fixture),
        }) as never,
    };
    const input = deliveryInput(fixture, "hook_build_changed", state, deps);
    input.deliver = async () => ({
      error: {
        tag: "ProtocolError",
        code: "OBSERVER_BUILD_MISMATCH",
        message: "Observer build changed before delivery.",
      },
    });

    await expect(deliverProviderHookWithSpooling(input)).resolves.toMatchObject({
      accepted: false,
      status: "rejected",
      error: { code: "OBSERVER_BUILD_MISMATCH" },
    });
    expect(state.spawnCount).toBe(0);
    expect(state.spooled).toBe(0);
  });
});

function deliveryInput(
  paths: Awaited<ReturnType<typeof createTempState>>,
  hookId: string,
  state: { running: boolean; spooled: number },
  deps: Parameters<typeof deliverProviderHookWithSpooling>[0]["deps"],
  options: {
    startupTimeoutMs?: number;
    observerCommand?: readonly [command: string, ...prefixArgs: string[]];
  } = {},
): Parameters<typeof deliverProviderHookWithSpooling>[0] {
  const event = hookEvent(hookId);
  const input: Parameters<typeof deliverProviderHookWithSpooling>[0] = {
    paths,
    event,
    payloadSummary: emptyPayloadSummary,
    autoStart: true,
    startupTimeoutMs: options.startupTimeoutMs ?? 500,
    rateLimitMs: 1000,
    deps,
    deliver: async () => {
      if (!state.running) return { error: offlineError(event) };
      return { receipt: ingestedReceipt(event) };
    },
    spoolReceipt: async (error) => {
      state.spooled += 1;
      return spooledReceipt(event, error);
    },
  };
  if (options.observerCommand !== undefined) {
    input.observerCommand = options.observerCommand;
  }
  return input;
}

const emptyPayloadSummary: ProviderHookPayloadSummary = {
  present: false,
  originalBytes: null,
  compactedBytes: null,
  compacted: false,
  omittedFieldNames: [],
};

function hookEvent(hookId: string): ProviderHookEvent {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId,
    provider: "worktrunk",
    kind: "worktree",
    event: "worktree.created",
    receivedAt: now,
  };
}

function ingestedReceipt(event: ProviderHookEvent): ProviderHookReceipt {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: event.hookId ?? "hook_test",
    provider: event.provider,
    event: event.event,
    accepted: true,
    status: "ingested",
    receivedAt: event.receivedAt,
    reconciled: false,
  };
}

function spooledReceipt(
  event: ProviderHookEvent,
  error: SafeError | undefined,
): ProviderHookReceipt {
  const receipt: ProviderHookReceipt = {
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: event.hookId ?? "hook_test",
    provider: event.provider,
    event: event.event,
    accepted: true,
    status: "spooled",
    receivedAt: event.receivedAt,
    spooled: true,
  };
  if (error !== undefined) {
    receipt.error = error;
  }
  return receipt;
}

function offlineError(event: ProviderHookEvent): SafeError {
  return {
    tag: "HookDeliveryError",
    code: "HOOK_DELIVERY_FAILED",
    message: "Observer is offline.",
    provider: event.provider,
  };
}

function healthyObserver(
  paths: { socketPath: string; stateDir: string },
  pid = 12345,
  version = buildVersion,
): ObserverHealth {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    status: "healthy",
    pid,
    startedAt: now,
    version,
    socketPath: paths.socketPath,
    stateDir: paths.stateDir,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}
