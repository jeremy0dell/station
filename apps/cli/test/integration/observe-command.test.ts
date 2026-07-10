import { runCli } from "@station/cli";
import { runObserveCommand } from "@station/cli/internal";
import type {
  EventFilter,
  ObserverApi,
  ReconcileReceipt,
  StationEvent,
  StationSnapshot,
} from "@station/contracts";
import { listenUnixSocket } from "@station/protocol";
import { describe, expect, it } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const now = "2026-06-05T12:00:00.000Z";

describe("CLI observe command", () => {
  it("emits JSONL event envelopes and suppresses final runCli output", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const chunks: string[] = [];

    const result = await runCli(["--config", configPath, "observe", "--json", "--limit", "2"], {
      observeDeps: { writeStdout: (chunk) => chunks.push(chunk), now: () => new Date(now) },
      observerDeps: runningObserverDeps({
        socketPath: fixture.socketPath,
        events: iterable([
          { type: "observer.started", at: now },
          { type: "observer.reconciled", at: now, changed: 1 },
        ]),
      }),
    });

    expect(result).toEqual({ code: 0 });
    expect(
      chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        kind: "event",
        seq: 1,
        receivedAt: now,
        event: { type: "observer.started", at: now },
      },
      {
        kind: "event",
        seq: 2,
        receivedAt: now,
        event: { type: "observer.reconciled", at: now, changed: 1 },
      },
    ]);
  });

  it("emits only the requested initial snapshot when --include-snapshot --limit 0 is used", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const chunks: string[] = [];

    const result = await runCli(
      ["--config", configPath, "observe", "--json", "--include-snapshot", "--limit", "0"],
      {
        observeDeps: { writeStdout: (chunk) => chunks.push(chunk), now: () => new Date(now) },
        observerDeps: runningObserverDeps({
          socketPath: fixture.socketPath,
          snapshot: snapshotFixture(),
          events: iterable([{ type: "observer.started", at: now }]),
        }),
      },
    );

    expect(result).toEqual({ code: 0 });
    expect(
      chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        kind: "snapshot",
        seq: 1,
        receivedAt: now,
        snapshot: snapshotFixture(),
      },
    ]);
  });

  it("renders pane mode in the alternate screen and restores the terminal", async () => {
    const fixture = await createTempState();
    const chunks: string[] = [];

    const result = await runObserveCommand(
      ["--pane", "--limit", "1"],
      { config: fixture.config },
      {
        isTty: true,
        terminalSize: () => ({ columns: 80, rows: 8 }),
        writeStdout: (chunk) => chunks.push(chunk),
        now: () => new Date(now),
        observer: runningObserverDeps({
          socketPath: fixture.socketPath,
          snapshot: snapshotFixture(),
          events: iterable([{ type: "observer.started", at: now }]),
        }),
      },
    );

    const output = chunks.join("");
    expect(result).toEqual({ code: 0 });
    expect(output).toContain("\x1b[?1049h");
    expect(output).toContain("\x1b[?25l");
    expect(output).toContain("stn observe  live");
    expect(output).toContain("snapshot   0 project");
    expect(output).toContain("observer   started");
    expect(output.endsWith("\x1b[?25h\x1b[?1049l")).toBe(true);
  });

  it("composes category union protocol filters with local identity narrowing", async () => {
    const fixture = await createTempState();
    const seenFilters: EventFilter[] = [];
    const chunks: string[] = [];

    await runObserveCommand(
      ["--json", "--agent", "--failed", "--trace", "trc_1", "--limit", "1"],
      { config: fixture.config },
      {
        writeStdout: (chunk) => chunks.push(chunk),
        now: () => new Date(now),
        observer: runningObserverDeps({
          socketPath: fixture.socketPath,
          events: iterable([
            { type: "worktree.agentStateChanged", worktreeId: "wt_1" },
            {
              type: "provider.healthChanged",
              provider: "codex",
              health: providerHealth("healthy"),
            },
            {
              type: "command.failed",
              commandId: "cmd_1",
              traceId: "trc_1",
              error: { tag: "CommandError", code: "COMMAND_FAILED", message: "failed" },
            },
          ]),
          onSubscribe: (filter) => {
            if (filter !== undefined) seenFilters.push(filter);
          },
        }),
      },
    );

    expect(seenFilters).toEqual([
      {
        type: [
          "worktree.agentStateChanged",
          "session.created",
          "session.updated",
          "session.removed",
          "command.failed",
          "provider.healthChanged",
        ],
        traceId: "trc_1",
      },
    ]);
    expect(JSON.parse(chunks.join("").trim()).event).toEqual({
      type: "command.failed",
      commandId: "cmd_1",
      traceId: "trc_1",
      error: { tag: "CommandError", code: "COMMAND_FAILED", message: "failed" },
    });
  });

  it("writes delayed events as they arrive", async () => {
    const fixture = await createTempState();
    const writes: Array<{ at: number; chunk: string }> = [];
    const startedAt = Date.now();

    await runObserveCommand(
      ["--json", "--limit", "2"],
      { config: fixture.config },
      {
        writeStdout: (chunk) => writes.push({ at: Date.now() - startedAt, chunk }),
        now: () => new Date(now),
        observer: runningObserverDeps({
          socketPath: fixture.socketPath,
          events: delayedIterable([
            { delayMs: 5, event: { type: "observer.started", at: now } },
            { delayMs: 40, event: { type: "observer.reconciled", at: now, changed: 1 } },
          ]),
        }),
      },
    );

    expect(writes).toHaveLength(2);
    expect(writes[0]?.at).toBeLessThan(35);
    expect(writes[1]?.at).toBeGreaterThanOrEqual(35);
  });

  it("returns the subscription iterator when a finite limit is reached", async () => {
    const fixture = await createTempState();
    let returned = false;

    await runObserveCommand(
      ["--limit", "1"],
      { config: fixture.config },
      {
        writeStdout: () => undefined,
        observer: runningObserverDeps({
          socketPath: fixture.socketPath,
          events: iterable([{ type: "observer.started", at: now }], () => {
            returned = true;
          }),
        }),
      },
    );

    expect(returned).toBe(true);
  });

  it("exits on duration when no matching event arrives", async () => {
    const fixture = await createTempState();
    let returned = false;
    const chunks: string[] = [];

    const result = await runObserveCommand(
      ["--duration", "50ms", "--type", "command.failed"],
      { config: fixture.config },
      {
        writeStdout: (chunk) => chunks.push(chunk),
        observer: runningObserverDeps({
          socketPath: fixture.socketPath,
          events: blockingIterable(() => {
            returned = true;
          }),
        }),
      },
    );

    expect(result).toEqual({ code: 0 });
    expect(chunks).toEqual([]);
    expect(returned).toBe(true);
  });

  it("surfaces observer socket schema errors with hint and code", async () => {
    const fixture = await createTempState();
    const server = await listenUnixSocket({
      socketPath: fixture.socketPath,
      onConnection: () => undefined,
    });
    let spawned = false;

    try {
      await expect(
        runObserveCommand(
          ["--duration", "1ms"],
          { config: fixture.config },
          {
            observer: {
              clientFactory: () =>
                ({
                  health: async () => {
                    throw {
                      tag: "ProtocolError",
                      code: "PROTOCOL_SCHEMA_MISMATCH",
                      message:
                        "Observer protocol schema mismatch: the observer responded with schema 0.3.0, but this CLI expects schema 0.7.0.",
                      hint: "A different STATION checkout may own the observer socket.",
                    };
                  },
                }) as never,
              spawnObserver: async () => {
                spawned = true;
                return { pid: 1234, unref: () => undefined };
              },
              sleep: async () => undefined,
            },
          },
        ),
      ).rejects.toThrow(
        [
          "Observer protocol schema mismatch: the observer responded with schema 0.3.0, but this CLI expects schema 0.7.0.",
          "Hint: A different STATION checkout may own the observer socket.",
          "Code: PROTOCOL_SCHEMA_MISMATCH",
        ].join("\n"),
      );
    } finally {
      await server.close();
    }

    expect(spawned).toBe(false);
  });
});

function runningObserverDeps(options: {
  socketPath: string;
  snapshot?: StationSnapshot;
  events: AsyncIterable<StationEvent>;
  onSubscribe?: (filter: EventFilter | undefined) => void;
}) {
  return {
    clientFactory: (socketPath: string) =>
      ({
        health: async () => ({
          schemaVersion: "0.7.0",
          status: "healthy",
          pid: 1234,
          startedAt: now,
          version: "0.0.0",
          socketPath,
        }),
        getSnapshot: async () => options.snapshot ?? snapshotFixture(),
        subscribe: (filter?: EventFilter) => {
          options.onSubscribe?.(filter);
          return options.events;
        },
        reconcile: async (reason?: string): Promise<ReconcileReceipt> => ({
          schemaVersion: "0.7.0",
          reason: reason ?? "manual",
          reconciledAt: now,
          snapshot: options.snapshot ?? snapshotFixture(),
        }),
      }) as ObserverApi,
    sleep: async () => undefined,
  };
}

function iterable(
  events: readonly StationEvent[],
  onReturn?: () => void,
): AsyncIterable<StationEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () => {
          const event = events[index];
          index += 1;
          return event === undefined
            ? { done: true, value: undefined }
            : { done: false, value: event };
        },
        return: async () => {
          onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function delayedIterable(
  items: readonly Array<{ delayMs: number; event: StationEvent }>,
): AsyncIterable<StationEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () => {
          const item = items[index];
          index += 1;
          if (item === undefined) {
            return { done: true, value: undefined };
          }
          await sleep(item.delayMs);
          return { done: false, value: item.event };
        },
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

function blockingIterable(onReturn: () => void): AsyncIterable<StationEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => new Promise<IteratorResult<StationEvent>>(() => undefined),
      return: async () => {
        onReturn();
        return { done: true, value: undefined };
      },
    }),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotFixture(): StationSnapshot {
  return {
    schemaVersion: "0.7.0",
    generatedAt: now,
    observer: { pid: 1234, startedAt: now, version: "0.0.0", healthy: true },
    providerHealth: {},
    projects: [],
    rows: [],
    sessions: [],
    counts: {
      projects: 0,
      worktrees: 0,
      agents: 0,
      working: 0,
      idle: 0,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  };
}

function providerHealth(status: "healthy" | "degraded") {
  return {
    providerId: "codex",
    providerType: "harness" as const,
    status,
    lastCheckedAt: now,
  };
}
