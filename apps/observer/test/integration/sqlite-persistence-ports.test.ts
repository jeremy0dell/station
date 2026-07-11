import type { ProviderProjectConfig, StationCommand } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  type CommandJournal,
  createSqliteObserverPersistence,
  type EventJournal,
  type IngressJournal,
  type ObservationStore,
  type ObserverPersistence,
  type ReconcileStore,
  type SessionStore,
  type WorktreeMetadataStore,
} from "../../src/persistence";
import { openObserverSqlite } from "../../src/sqlite";

const now = "2026-05-20T12:00:00.000Z";
const later = "2026-05-20T12:01:00.000Z";

const command: StationCommand = {
  type: "observer.reconcile",
  payload: { reason: "sqlite-port-contract" },
};

const project: ProviderProjectConfig = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaults: {
    harness: "fake-harness",
    terminal: "fake-terminal",
    layout: "agent-shell",
  },
  worktrunk: { enabled: true },
};

function ids(prefix = "port") {
  let event = 0;
  let observation = 0;
  return {
    eventId: () => `${prefix}_evt_${++event}`,
    observationId: () => `${prefix}_obs_${++observation}`,
  };
}

function narrowPersistencePorts(persistence: ObserverPersistence): {
  commandJournal: CommandJournal;
  eventJournal: EventJournal;
  ingressJournal: IngressJournal;
  observationStore: ObservationStore;
  reconcileStore: ReconcileStore;
  sessionStore: SessionStore;
  worktreeMetadataStore: WorktreeMetadataStore;
} {
  return {
    commandJournal: persistence,
    eventJournal: persistence,
    ingressJournal: persistence,
    observationStore: persistence,
    reconcileStore: persistence,
    sessionStore: persistence,
    worktreeMetadataStore: persistence,
  };
}

describe("SQLite observer persistence ports", () => {
  it("satisfies every application persistence port with unchanged SQLite behavior", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids(),
    });
    const {
      commandJournal,
      eventJournal,
      ingressJournal,
      observationStore,
      reconcileStore,
      sessionStore,
      worktreeMetadataStore,
    } = narrowPersistencePorts(persistence);

    await commandJournal.recordCommandAccepted({ commandId: "cmd_port", command, createdAt: now });
    await commandJournal.markCommandSucceeded("cmd_port", later);
    await expect(commandJournal.getCommand("cmd_port")).resolves.toMatchObject({
      id: "cmd_port",
      status: "succeeded",
      finishedAt: later,
    });

    await eventJournal.recordEvent({ type: "observer.started", at: now }, { createdAt: now });
    await expect(eventJournal.listEvents({ type: "observer.started" })).resolves.toEqual([
      expect.objectContaining({ id: "port_evt_1", type: "observer.started" }),
    ]);

    const ingressEvent = {
      type: "providerHook.ingested" as const,
      at: now,
      hookId: "hook_port",
      provider: "fake-harness",
      event: "run.updated",
    };
    const ingressOptions = {
      createdAt: now,
      source: "hook",
      dedupe: { kind: "hook" as const, id: "hook_port" },
    };
    await expect(
      ingressJournal.recordEventWithIngressDedupe(ingressEvent, ingressOptions),
    ).resolves.toMatchObject({ deduped: false, event: { id: "port_evt_2" } });
    await expect(
      ingressJournal.recordEventWithIngressDedupe(ingressEvent, ingressOptions),
    ).resolves.toEqual({ deduped: true });

    await observationStore.recordProviderObservation({
      provider: "fake-harness",
      providerType: "harness",
      entityKind: "provider_health",
      entityKey: "fake-harness",
      payload: { status: "healthy" },
      observedAt: now,
      expiresAt: later,
    });
    await expect(
      observationStore.listProviderObservations({ entityKind: "provider_health", now }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "port_obs_1",
        entityKey: "fake-harness",
        payload: { status: "healthy" },
      }),
    ]);

    const worktree = createFakeWorktree({
      id: "wt_web_port",
      projectId: "web",
      branch: "feature/persistence-ports",
      now,
    });
    const terminalTarget = createFakeTerminalTarget({
      id: "term_web_port",
      projectId: "web",
      worktreeId: worktree.id,
      sessionId: "ses_web_port",
      harnessRunId: "run_web_port",
      now,
    });
    const harnessRun = createFakeHarnessRun({
      id: "run_web_port",
      projectId: "web",
      worktreeId: worktree.id,
      sessionId: "ses_web_port",
      now,
    });
    await reconcileStore.persistReconcileResult({
      projects: [project],
      worktrees: [worktree],
      terminalTargets: [terminalTarget],
      harnessRuns: [harnessRun],
      observedAt: now,
    });
    await expect(reconcileStore.listProjects()).resolves.toEqual([
      expect.objectContaining({ id: "web" }),
    ]);
    await expect(reconcileStore.listWorktrees()).resolves.toEqual([
      expect.objectContaining({ id: worktree.id }),
    ]);
    await expect(reconcileStore.listTerminalTargets()).resolves.toEqual([
      expect.objectContaining({ id: terminalTarget.id, sessionId: "ses_web_port" }),
    ]);
    await expect(reconcileStore.listHarnessRuns()).resolves.toEqual([
      expect.objectContaining({ id: harnessRun.id, sessionId: "ses_web_port" }),
    ]);
    await expect(reconcileStore.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "ses_web_port", title: "feature/persistence-ports" }),
    ]);

    await sessionStore.renameSession({
      sessionId: "ses_web_port",
      title: "Persistence ports",
    });
    await expect(reconcileStore.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "ses_web_port", title: "Persistence ports" }),
    ]);

    await worktreeMetadataStore.upsertWorktreeMetadataCurrent({
      worktreeId: worktree.id,
      kind: "change_summary",
      expiresAt: later,
      payload: {
        kind: "branch_diff",
        additions: 7,
        deletions: 2,
        source: "local_git",
        checkedAt: now,
      },
    });
    await expect(
      worktreeMetadataStore.listWorktreeMetadataCurrent({ kind: "change_summary", now }),
    ).resolves.toEqual([
      expect.objectContaining({
        worktreeId: worktree.id,
        kind: "change_summary",
        payload: expect.objectContaining({ additions: 7, deletions: 2 }),
      }),
    ]);
    await expect(
      worktreeMetadataStore.deleteWorktreeMetadataCurrent({ worktreeId: worktree.id }),
    ).resolves.toBe(1);

    sqlite.close();
  });

  it("rolls back a failed atomic ingress write so the same dedupe key can be retried", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
      idFactory: ids("atomic"),
    });
    const { eventJournal, ingressJournal, observationStore } = narrowPersistencePorts(persistence);
    const input: Parameters<
      IngressJournal["recordEventAndProviderObservationWithIngressDedupe"]
    >[0] = {
      event: {
        type: "providerHook.ingested",
        at: now,
        hookId: "hook_atomic",
        provider: "fake-harness",
        event: "run.updated",
      },
      eventOptions: { createdAt: now, source: "hook" },
      observation: {
        provider: "fake-harness",
        providerType: "harness",
        entityKind: "provider_health",
        entityKey: "reject-once",
        payload: { status: "healthy" },
        observedAt: now,
      },
      dedupe: { kind: "hook", id: "hook_atomic" },
    };

    sqlite.database.exec(`
      CREATE TRIGGER reject_atomic_observation
      BEFORE INSERT ON provider_observations
      WHEN NEW.entity_key = 'reject-once'
      BEGIN
        SELECT RAISE(ABORT, 'forced observation failure');
      END;
    `);

    await expect(
      ingressJournal.recordEventAndProviderObservationWithIngressDedupe(input),
    ).rejects.toThrow("PERSISTENCE_TRANSACTION_FAILED");
    await expect(eventJournal.listEvents()).resolves.toEqual([]);
    await expect(
      observationStore.listProviderObservations({ includeExpired: true, now }),
    ).resolves.toEqual([]);
    expect(
      sqlite.database.prepare("SELECT COUNT(*) AS count FROM hook_ingress_dedupe").get(),
    ).toMatchObject({ count: 0 });
    expect(sqlite.database.prepare("SELECT COUNT(*) AS count FROM events").get()).toMatchObject({
      count: 0,
    });
    expect(
      sqlite.database.prepare("SELECT COUNT(*) AS count FROM provider_observations").get(),
    ).toMatchObject({ count: 0 });

    sqlite.database.exec("DROP TRIGGER reject_atomic_observation");

    await expect(
      ingressJournal.recordEventAndProviderObservationWithIngressDedupe(input),
    ).resolves.toMatchObject({
      deduped: false,
      event: { id: "atomic_evt_2" },
      observation: { id: "atomic_obs_2", entityKey: "reject-once" },
    });
    await expect(
      ingressJournal.recordEventAndProviderObservationWithIngressDedupe(input),
    ).resolves.toEqual({ deduped: true });
    await expect(eventJournal.listEvents()).resolves.toHaveLength(1);
    await expect(
      observationStore.listProviderObservations({ includeExpired: true, now }),
    ).resolves.toHaveLength(1);

    sqlite.close();
  });
});
