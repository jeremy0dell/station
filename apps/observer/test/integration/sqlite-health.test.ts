import { createFakeTerminalTarget } from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  createSqliteObserverPersistence,
  latestSchemaVersion,
  migrations,
  openObserverSqlite,
} from "../../src/internal";

const now = "2026-05-20T12:00:00.000Z";

describe("observer SQLite health", () => {
  it("initializes an in-memory database, reports health, and closes cleanly", () => {
    const sqlite = openObserverSqlite({
      path: ":memory:",
      clock: {
        now: () => new Date(now),
      },
    });

    expect(sqlite.health()).toMatchObject({
      path: ":memory:",
      open: true,
      status: "healthy",
      schemaVersion: latestSchemaVersion,
      lastCheckedAt: now,
    });
    expect(sqlite.health().migrations.map((migration) => migration.version)).toEqual(
      migrations.map((migration) => migration.version),
    );

    sqlite.close();

    expect(sqlite.health()).toMatchObject({
      path: ":memory:",
      open: false,
      status: "closed",
      schemaVersion: latestSchemaVersion,
      lastCheckedAt: now,
    });
  });

  it("retains the last SQLite transaction failure in health", async () => {
    const sqlite = openObserverSqlite({
      path: ":memory:",
      clock: {
        now: () => new Date(now),
      },
    });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
    });

    sqlite.close();

    await expect(
      persistence.recordEvent(
        {
          type: "observer.started",
          at: now,
        },
        { createdAt: now },
      ),
    ).rejects.toThrow("PERSISTENCE_TRANSACTION_FAILED");
    expect(sqlite.health()).toMatchObject({
      status: "closed",
      lastError: {
        code: "PERSISTENCE_TRANSACTION_FAILED",
      },
    });
  });

  it("reports malformed stored observations as persistence failures", async () => {
    const sqlite = openObserverSqlite({
      path: ":memory:",
      clock: { now: () => new Date(now) },
    });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
    });
    sqlite.database
      .prepare(
        `
          INSERT INTO provider_observations
            (id, provider, provider_type, entity_kind, entity_key, payload_json, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "obs_corrupt",
        "fake-harness",
        "observer",
        "provider_health",
        "fake-harness",
        JSON.stringify({ status: "healthy" }),
        now,
      );

    await expect(
      persistence.listProviderObservations({ includeExpired: true, now }),
    ).rejects.toThrow("PERSISTENCE_TRANSACTION_FAILED");
    expect(persistence.health()).toMatchObject({
      status: "unavailable",
      lastError: { code: "PERSISTENCE_TRANSACTION_FAILED" },
    });

    sqlite.close();
  });

  it("rejects malformed observations before writing and records the failure in health", async () => {
    const sqlite = openObserverSqlite({
      path: ":memory:",
      clock: { now: () => new Date(now) },
    });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
    });
    const malformedObservation = {
      provider: "fake-harness",
      providerType: "harness",
      entityKind: "provider_health",
      entityKey: "fake-harness",
      payload: { status: "healthy" },
      observedAt: now,
    } as unknown as Parameters<typeof persistence.recordProviderObservation>[0];

    await expect(persistence.recordProviderObservation(malformedObservation)).rejects.toThrow(
      "PERSISTENCE_TRANSACTION_FAILED",
    );
    expect(
      sqlite.database.prepare("SELECT COUNT(*) AS count FROM provider_observations").get(),
    ).toMatchObject({ count: 0 });
    expect(persistence.health()).toMatchObject({
      status: "unavailable",
      lastError: { code: "PERSISTENCE_TRANSACTION_FAILED" },
    });

    sqlite.close();
  });

  it("strips terminal provider data before storing the observation payload", async () => {
    const sqlite = openObserverSqlite({
      path: ":memory:",
      clock: { now: () => new Date(now) },
    });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date(now) },
    });
    const terminal = createFakeTerminalTarget({
      id: "term_private_data",
      now,
      providerData: { socketPath: "/tmp/private.sock" },
    });

    await persistence.recordProviderObservation({
      provider: terminal.provider,
      providerType: "terminal",
      entityKind: "terminal_target",
      entityKey: terminal.id,
      payload: terminal,
      observedAt: now,
    });

    const row = sqlite.database
      .prepare("SELECT payload_json FROM provider_observations WHERE entity_key = ?")
      .get(terminal.id) as { payload_json: string };
    expect(JSON.parse(row.payload_json)).not.toHaveProperty("providerData");

    sqlite.close();
  });
});
