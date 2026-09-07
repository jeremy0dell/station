import { createFakeTerminalTarget } from "@station/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSqliteObserverPersistence,
  latestSchemaVersion,
  migrations,
  openObserverSqlite,
} from "../../src/internal";
import * as driver from "../../src/sqlite/driver.js";

const now = "2026-05-20T12:00:00.000Z";

afterEach(() => vi.restoreAllMocks());

describe("observer SQLite health", () => {
  it.each([
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "CREATE TABLE",
    "DELETE FROM observer_migrations",
  ])("closes the connection when initialization fails at %s", (statement) => {
    const database = driver.openSqlDatabase(":memory:");
    const originalExec = database.exec;
    const originalPrepare = database.prepare;
    const failure = new Error("fixture SQLite failure");
    const close = vi.spyOn(database, "close");
    vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql.includes(statement)) throw failure;
      originalExec(sql);
    });
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      if (sql.includes(statement)) throw failure;
      return originalPrepare(sql);
    });
    vi.spyOn(driver, "openSqlDatabase").mockReturnValue(database);
    expect(() => openObserverSqlite({ path: "fixture.sqlite" })).toThrow(
      expect.objectContaining({
        tag: "PersistenceInitializationError",
        code: statement.startsWith("PRAGMA")
          ? "PERSISTENCE_PRAGMA_FAILED"
          : "PERSISTENCE_MIGRATION_FAILED",
        cause: failure,
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(() => originalExec("SELECT 1")).toThrow();
  });
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
