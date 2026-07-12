import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import type {
  ObserverHealth,
  ProviderHookEvent,
  ProviderHookPayloadSummary,
  ProviderHookReceipt,
  SafeError,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createTempState } from "../../../../tests/support/temp-projects";
import { deliverProviderHookWithSpooling } from "../../src/ingress/deliveryPolicy.js";

const now = "2026-05-20T12:00:00.000Z";

describe("provider hook delivery policy", () => {
  it("forwards the finalized observer command unchanged to auto-start", async () => {
    const fixture = await createTempState();
    const state = { running: false, spawnCount: 0, spooled: 0 };
    const observerCommand = ["/opt/station/stn", "__observer"] as const;
    let observedCommand: readonly string[] | undefined;
    const deps = {
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

  it("serializes concurrent observer auto-start attempts across hook senders", async () => {
    const fixture = await createTempState();
    const state = { running: false, spawnCount: 0, spooled: 0 };
    const gate = deferred();
    const deps = {
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

function healthyObserver(paths: { socketPath: string; stateDir: string }): ObserverHealth {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    status: "healthy",
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
