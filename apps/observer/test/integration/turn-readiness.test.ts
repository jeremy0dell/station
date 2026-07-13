import type { StationConfig } from "@station/config";
import type { HarnessEventReport } from "@station/contracts";
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
});

function workingReport(reportId: string): HarnessEventReport {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId,
    provider: "fake-harness",
    kind: "harness",
    eventType: "PreToolUse",
    observedAt: completedAt,
    status: {
      value: "working",
      confidence: "medium",
      reason: "Harness is using a tool.",
      source: "harness_event",
      updatedAt: completedAt,
    },
    correlation: {
      harnessRunId: "run_web_ready",
    },
  };
}

function fixtureCore() {
  const clock = { now: () => new Date(now) };
  const sqlite = openObserverSqlite({ clock });
  const ids = observerIds();
  const persistence = createSqliteObserverPersistence({
    sqlite,
    clock,
    idFactory: ids,
  });
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
            state: "idle",
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
  return { core, persistence, queue, sqlite };
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

function report(input: { reportId: string; turnCompleted: boolean }): HarnessEventReport {
  const report: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "fake-harness",
    kind: "harness",
    eventType: "Stop",
    observedAt: completedAt,
    status: {
      value: "idle",
      confidence: "high",
      reason: "Harness completed a visible turn.",
      source: "harness_event",
      updatedAt: completedAt,
    },
    correlation: {
      harnessRunId: "run_web_ready",
    },
    diagnostics: {
      rawEventType: "Stop",
    },
  };
  if (input.turnCompleted) {
    report.turn = { kind: "turn_completed" };
  }
  return report;
}
