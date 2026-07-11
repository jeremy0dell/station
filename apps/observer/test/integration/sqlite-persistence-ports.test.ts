import { describe, expect, it } from "vitest";
import { createSqliteObserverPersistence, type IngressJournal } from "../../src/persistence";
import { openObserverSqlite } from "../../src/sqlite";
import { observerPersistenceContract } from "../support/observerPersistenceContract";

const now = "2026-05-20T12:00:00.000Z";

observerPersistenceContract("SQLite", ({ clock, idFactory }) => {
  const sqlite = openObserverSqlite({ clock });
  return {
    persistence: createSqliteObserverPersistence({ sqlite, clock, idFactory }),
    close: () => sqlite.close(),
  };
});

describe("SQLite-only Observer persistence behavior", () => {
  it("exposes healthy SQLite status in addition to the seven application ports", () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    try {
      const persistence = createSqliteObserverPersistence({
        sqlite,
        clock: { now: () => new Date(now) },
      });

      expect(persistence.health()).toMatchObject({
        open: true,
        status: "healthy",
        lastCheckedAt: now,
      });
    } finally {
      sqlite.close();
    }
  });

  it("rolls back a trigger-rejected ingress write before permitting the same key to retry", async () => {
    const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
    try {
      const persistence = createSqliteObserverPersistence({
        sqlite,
        clock: { now: () => new Date(now) },
        idFactory: ids(),
      });
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
          payload: {
            providerId: "fake-harness",
            providerType: "harness",
            status: "healthy",
            lastCheckedAt: now,
          },
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
        persistence.recordEventAndProviderObservationWithIngressDedupe(input),
      ).rejects.toThrow("PERSISTENCE_TRANSACTION_FAILED");
      await expect(persistence.listEvents()).resolves.toEqual([]);
      await expect(
        persistence.listProviderObservations({ includeExpired: true, now }),
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
        persistence.recordEventAndProviderObservationWithIngressDedupe(input),
      ).resolves.toMatchObject({
        deduped: false,
        event: { id: "atomic_evt_2" },
        observation: { id: "atomic_obs_2", entityKey: "reject-once" },
      });
      await expect(
        persistence.recordEventAndProviderObservationWithIngressDedupe(input),
      ).resolves.toEqual({ deduped: true });
    } finally {
      sqlite.close();
    }
  });
});

function ids() {
  let event = 0;
  let observation = 0;
  return {
    eventId: () => `atomic_evt_${++event}`,
    observationId: () => `atomic_obs_${++observation}`,
  };
}
