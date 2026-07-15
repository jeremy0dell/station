import type { StationConfig } from "@station/config";
import type { AgentState, HarnessEventReport } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  createCommandQueue,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  type ObserverPersistenceBundle,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
} from "../../src/internal";
import { createUnexpectedProjectConfigWriter } from "../support/projectConfigWriter.js";

const now = "2026-06-17T12:00:00.000Z";
const completedAt = "2026-06-17T12:00:01.000Z";

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "fake-harness",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};

describe("observer turn readiness", () => {
  it("persists and projects ready-to-read markers only for explicit completed turns", async () => {
    const fixture = fixtureCore();
    await fixture.core.reconcile("turn-readiness-initial");

    const completed = await fixture.core.projectHarnessEventStatus(
      report({
        reportId: "report_turn_complete",
        turnCompleted: true,
      }),
    );

    expect(completed.projected).toBe(true);
    expect(completed.snapshot.rows[0]?.agent?.turnReadiness).toEqual({
      state: "ready_to_read",
      token: "report_turn_complete",
      completedAt,
    });
    expect(completed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "worktree.updated",
          worktreeId: "wt_web_ready",
          patch: {
            agent: expect.objectContaining({
              turnReadiness: {
                state: "ready_to_read",
                token: "report_turn_complete",
                completedAt,
              },
            }),
          },
        }),
      ]),
    );
    expect(
      (await fixture.persistence.listSessionTurnReadiness()).find(
        (readiness) => readiness.sessionId === "ses_web_ready",
      ),
    ).toMatchObject({
      sessionId: "ses_web_ready",
      token: "report_turn_complete",
      completedAt,
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.acknowledgeTurn",
      payload: {
        sessionId: "ses_web_ready",
        token: "report_turn_complete",
      },
    });
    await fixture.queue.drain();

    expect(receipt.accepted).toBe(true);
    expect(
      (await fixture.persistence.listSessionTurnReadiness()).find(
        (readiness) => readiness.sessionId === "ses_web_ready",
      ),
    ).toBeUndefined();
    expect(fixture.core.getSnapshot().rows[0]?.agent).not.toHaveProperty("turnReadiness");
    expect(
      (await fixture.persistence.listEvents({ commandId: receipt.commandId })).map(
        (event) => event.type,
      ),
    ).toEqual(["command.accepted", "command.started", "worktree.updated", "command.succeeded"]);
    fixture.sqlite.close();

    const plainFixture = fixtureCore();
    await plainFixture.core.reconcile("plain-idle-initial");

    const plainIdle = await plainFixture.core.projectHarnessEventStatus(
      report({
        reportId: "report_plain_idle",
        turnCompleted: false,
      }),
    );

    expect(plainIdle.projected).toBe(true);
    expect(plainIdle.snapshot.rows[0]?.agent).not.toHaveProperty("turnReadiness");
    expect(
      (await plainFixture.persistence.listSessionTurnReadiness()).find(
        (readiness) => readiness.sessionId === "ses_web_ready",
      ),
    ).toBeUndefined();
    plainFixture.sqlite.close();
  });

  it("clears ready-to-read when the session becomes active again", async () => {
    const fixture = fixtureCore();
    await fixture.core.reconcile("turn-readiness-active-clear");

    await fixture.core.projectHarnessEventStatus(
      report({ reportId: "report_ready_then_active", turnCompleted: true }),
    );
    expect(
      (await fixture.persistence.listSessionTurnReadiness()).find(
        (readiness) => readiness.sessionId === "ses_web_ready",
      ),
    ).toMatchObject({ token: "report_ready_then_active" });

    // The user re-engages the harness directly: the new turn's working event
    // must close the readiness interval without an explicit acknowledgment.
    const working = await fixture.core.projectHarnessEventStatus(
      workingReport("report_new_turn_working"),
    );
    expect(working.projected).toBe(true);
    expect(
      (await fixture.persistence.listSessionTurnReadiness()).find(
        (readiness) => readiness.sessionId === "ses_web_ready",
      ),
    ).toBeUndefined();
    expect(fixture.core.getSnapshot().rows[0]?.agent).not.toHaveProperty("turnReadiness");
    fixture.sqlite.close();
  });

  it("drops a completion superseded while its readiness write is in flight", async () => {
    const upsertStarted = deferred<void>();
    const continueUpsert = deferred<void>();
    const fixture = fixtureCore({
      harnessState: "working",
      decoratePersistence: (persistence) => ({
        ...persistence,
        upsertSessionTurnReadiness: async (input) => {
          upsertStarted.resolve();
          await continueUpsert.promise;
          return persistence.upsertSessionTurnReadiness(input);
        },
      }),
    });
    let completion: ReturnType<typeof fixture.core.projectHarnessEventStatus> | undefined;

    try {
      await fixture.core.reconcile("turn-readiness-race-initial");
      completion = fixture.core.projectHarnessEventStatus(
        report({ reportId: "report_superseded_stop", turnCompleted: true }),
      );
      await upsertStarted.promise;

      const working = await fixture.core.projectHarnessEventStatus(
        workingReport("report_working_during_stop", "2026-06-17T12:00:02.000Z"),
      );
      expect(working.projected).toBe(true);
      expect(fixture.core.getSnapshot().rows[0]?.agent).toMatchObject({ state: "working" });

      await fixture.basePersistence.upsertSessionTurnReadiness({
        sessionId: "ses_web_ready",
        projectId: "web",
        worktreeId: "wt_web_ready",
        token: "report_newer_completion",
        completedAt: "2026-06-17T12:00:03.000Z",
        createdAt: "2026-06-17T12:00:03.000Z",
        updatedAt: "2026-06-17T12:00:03.000Z",
      });

      continueUpsert.resolve();
      const superseded = await completion;
      expect(superseded).toMatchObject({ projected: false, events: [] });
      expect(fixture.core.getSnapshot().rows[0]?.agent).toMatchObject({ state: "working" });
      await expect(fixture.persistence.listSessionTurnReadiness()).resolves.toEqual([
        expect.objectContaining({ token: "report_newer_completion" }),
      ]);
    } finally {
      continueUpsert.resolve();
      await completion?.catch(() => undefined);
      fixture.sqlite.close();
    }
  });

  it("does not let a binding lookup reorder live status projections", async () => {
    const lookupStarted = deferred<void>();
    const continueLookup = deferred<void>();
    let lookupCount = 0;
    const fixture = fixtureCore({
      harnessState: "working",
      decoratePersistence: (persistence) => ({
        ...persistence,
        getSessionHarnessExecution: async () => {
          lookupCount += 1;
          if (lookupCount === 1) {
            lookupStarted.resolve();
            await continueLookup.promise;
          }
          return {
            provider: "fake-harness",
            sessionId: "ses_web_ready",
            nativeSessionId: "native_web_ready",
            state: "working",
            statusUpdatedAt: now,
          };
        },
      }),
    });
    let older: ReturnType<typeof fixture.core.projectHarnessEventStatus> | undefined;

    try {
      await fixture.core.reconcile("binding-lookup-race-initial");
      fixture.setClockNow("2026-06-17T12:00:01.000Z");
      older = fixture.core.projectHarnessEventStatus(
        report({
          reportId: "report_older_idle",
          turnCompleted: false,
          observedAt: "2026-06-17T12:00:01.000Z",
          nativeSessionId: "native_web_ready",
        }),
      );
      await lookupStarted.promise;

      fixture.setClockNow("2026-06-17T12:00:02.000Z");
      const newer = fixture.core.projectHarnessEventStatus(
        workingReport("report_newer_working", "2026-06-17T12:00:02.000Z", "native_web_ready"),
      );
      await Promise.resolve();
      continueLookup.resolve();
      await Promise.all([older, newer]);

      expect(fixture.core.getSnapshot()).toMatchObject({
        generatedAt: "2026-06-17T12:00:02.000Z",
        rows: [
          expect.objectContaining({
            agent: expect.objectContaining({
              state: "working",
              updatedAt: "2026-06-17T12:00:02.000Z",
            }),
          }),
        ],
        sessions: [
          expect.objectContaining({
            status: expect.objectContaining({
              value: "working",
              updatedAt: "2026-06-17T12:00:02.000Z",
            }),
          }),
        ],
      });
    } finally {
      continueLookup.resolve();
      await older?.catch(() => undefined);
      fixture.sqlite.close();
    }
  });

  it("keeps an authorized report diagnostic-only when its projection identities disagree", async () => {
    const fixture = fixtureCore({
      harnessState: "working",
      decoratePersistence: (persistence) => ({
        ...persistence,
        getSessionHarnessExecution: async ({ provider, sessionId }) => ({
          provider,
          sessionId,
          nativeSessionId: "native_ended_a",
          state: "working",
          statusUpdatedAt: now,
        }),
      }),
    });

    try {
      await fixture.core.reconcile("projection-identity-mismatch");
      const foreignCompletion = report({
        reportId: "report_ended_a_completion",
        turnCompleted: true,
        nativeSessionId: "native_ended_a",
      });
      foreignCompletion.correlation = {
        ...foreignCompletion.correlation,
        sessionId: "ses_ended_a",
      };

      const result = await fixture.core.projectHarnessEventStatus(foreignCompletion);

      expect(result).toMatchObject({ projected: false, events: [] });
      expect(fixture.core.getSnapshot().rows[0]?.agent).toMatchObject({ state: "working" });
      await expect(fixture.persistence.listSessionTurnReadiness()).resolves.toEqual([]);
    } finally {
      fixture.sqlite.close();
    }
  });

  it("rejects a readiness marker owned by a newer completion", async () => {
    const upsertStarted = deferred<void>();
    const continueUpsert = deferred<void>();
    const fixture = fixtureCore({
      harnessState: "working",
      decoratePersistence: (persistence) => ({
        ...persistence,
        upsertSessionTurnReadiness: async (input) => {
          if (input.token === "report_older_completion") {
            upsertStarted.resolve();
            await continueUpsert.promise;
          }
          return persistence.upsertSessionTurnReadiness(input);
        },
      }),
    });
    let older: ReturnType<typeof fixture.core.projectHarnessEventStatus> | undefined;

    try {
      await fixture.core.reconcile("readiness-token-race-initial");
      older = fixture.core.projectHarnessEventStatus(
        report({
          reportId: "report_older_completion",
          turnCompleted: true,
          observedAt: "2026-06-17T12:00:01.000Z",
        }),
      );
      await upsertStarted.promise;

      await fixture.core.projectHarnessEventStatus(
        workingReport("report_newer_turn", "2026-06-17T12:00:02.000Z"),
      );
      const newer = await fixture.core.projectHarnessEventStatus(
        report({
          reportId: "report_newer_completion",
          turnCompleted: true,
          observedAt: "2026-06-17T12:00:03.000Z",
        }),
      );
      expect(newer.snapshot.rows[0]?.agent?.turnReadiness).toMatchObject({
        token: "report_newer_completion",
      });

      continueUpsert.resolve();
      await expect(older).resolves.toMatchObject({ projected: false, events: [] });
      expect(fixture.core.getSnapshot().rows[0]?.agent?.turnReadiness).toMatchObject({
        token: "report_newer_completion",
      });
      await expect(fixture.persistence.listSessionTurnReadiness()).resolves.toEqual([
        expect.objectContaining({ token: "report_newer_completion" }),
      ]);
    } finally {
      continueUpsert.resolve();
      await older?.catch(() => undefined);
      fixture.sqlite.close();
    }
  });
});

function workingReport(
  reportId: string,
  observedAt = completedAt,
  nativeSessionId?: string,
): HarnessEventReport {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId,
    provider: "fake-harness",
    kind: "harness",
    eventType: "PreToolUse",
    observedAt,
    status: {
      value: "working",
      confidence: "medium",
      reason: "Harness is using a tool.",
      source: "harness_event",
      updatedAt: observedAt,
    },
    correlation: nativeCorrelation(nativeSessionId),
  };
}

function fixtureCore(
  options: {
    harnessState?: AgentState;
    decoratePersistence?: (persistence: ObserverPersistenceBundle) => ObserverPersistenceBundle;
  } = {},
) {
  let clockNow = now;
  const clock = { now: () => new Date(clockNow) };
  const sqlite = openObserverSqlite({ clock });
  const ids = observerIds();
  const basePersistence = createSqliteObserverPersistence({
    sqlite,
    clock,
    idFactory: ids,
  });
  const persistence = options.decoratePersistence?.(basePersistence) ?? basePersistence;
  const eventBus = createObserverEventBus();
  const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus });
  const providers = new ProviderRegistry({
    worktree: new FakeWorktreeProvider({
      now,
      worktrees: [
        createFakeWorktree({
          id: "wt_web_ready",
          projectId: "web",
          branch: "ready",
          path: "/tmp/station/web/ready",
          now,
        }),
      ],
    }),
    terminal: new FakeTerminalProvider({
      now,
      targets: [
        createFakeTerminalTarget({
          id: "term_web_ready",
          provider: "fake-terminal",
          projectId: "web",
          worktreeId: "wt_web_ready",
          sessionId: "ses_web_ready",
          harnessRunId: "run_web_ready",
          now,
        }),
      ],
    }),
    harnesses: [
      new FakeHarnessProvider({
        now,
        runs: [
          createFakeHarnessRun({
            id: "run_web_ready",
            provider: "fake-harness",
            projectId: "web",
            worktreeId: "wt_web_ready",
            sessionId: "ses_web_ready",
            state: options.harnessState ?? "idle",
            now,
          }),
        ],
      }),
    ],
  });
  const core = createObserverCore({ config, providers, persistence, clock });
  registerObserverCommandHandlers({
    projectConfigWriter: createUnexpectedProjectConfigWriter(),
    queue,
    core,
    providers,
    projects: config.projects,
    persistence,
    eventBus,
    clock,
  });
  return {
    basePersistence,
    core,
    persistence,
    queue,
    setClockNow: (value: string) => {
      clockNow = value;
    },
    sqlite,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function observerIds() {
  let command = 0;
  let event = 0;
  let error = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => {
      command += 1;
      return `cmd_turn_${command}`;
    },
    eventId: () => {
      event += 1;
      return `evt_turn_${event}`;
    },
    errorId: () => {
      error += 1;
      return `err_turn_${error}`;
    },
    observationId: () => {
      observation += 1;
      return `obs_turn_${observation}`;
    },
    breadcrumbId: () => {
      breadcrumb += 1;
      return `crumb_turn_${breadcrumb}`;
    },
  };
}

function report(input: {
  reportId: string;
  turnCompleted: boolean;
  observedAt?: string;
  nativeSessionId?: string;
}): HarnessEventReport {
  const observedAt = input.observedAt ?? completedAt;
  const report: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "fake-harness",
    kind: "harness",
    eventType: "Stop",
    observedAt,
    status: {
      value: "idle",
      confidence: "high",
      reason: "Harness completed a visible turn.",
      source: "harness_event",
      updatedAt: observedAt,
    },
    correlation: nativeCorrelation(input.nativeSessionId),
    diagnostics: {
      rawEventType: "Stop",
    },
  };
  if (input.turnCompleted) {
    report.turn = { kind: "turn_completed" };
  }
  return report;
}

function nativeCorrelation(
  nativeSessionId?: string,
): NonNullable<HarnessEventReport["correlation"]> {
  if (nativeSessionId === undefined) {
    return { harnessRunId: "run_web_ready" };
  }
  return {
    harnessRunId: "run_web_ready",
    sessionId: "ses_web_ready",
    nativeSessionId,
  };
}
