import assert from "node:assert/strict";

const [, , action, databasePath, expectedLabel] = process.argv;
assert.ok(
  action === "seed-v16" || action === "upgrade-write" || action === "read",
  "Expected a seed-v16, upgrade-write, or read action.",
);
assert.ok(databasePath, "Expected a SQLite database path.");
assert.ok(expectedLabel, "Expected a probe label.");

const { createSqliteObserverPersistence, migrations, openObserverSqlite } = await import(
  new URL("../../apps/observer/dist/internal.js", import.meta.url).href
);
if (action === "seed-v16") {
  const { openSqlDatabase } = await import(
    new URL("../../apps/observer/dist/sqlite/driver.js", import.meta.url).href
  );
  const database = openSqlDatabase(databasePath);
  try {
    for (const migration of migrations.filter(({ version }) => version <= 16)) {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO observer_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, "2026-01-01T00:00:00.000Z");
    }
    database
      .prepare("INSERT OR REPLACE INTO observer_meta (key, value) VALUES ('schema_version', '16')")
      .run();
  } finally {
    database.close();
  }
  process.exit(0);
}
const roundTripInteger = 2_147_483_648;
const sqlite = openObserverSqlite({
  path: databasePath,
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
});

try {
  const { database } = sqlite;
  assert.equal(database.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(database.prepare("PRAGMA synchronous").get()?.synchronous, 1);
  assert.deepEqual(
    sqlite.health().migrations.map(({ version, name }) => ({ version, name })),
    migrations.map(({ version, name }) => ({ version, name })),
  );
  assert.equal(sqlite.health().schemaVersion, migrations.at(-1)?.version ?? 0);

  database.exec(`
    CREATE TABLE IF NOT EXISTS station_runtime_probe (
      label TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )
  `);
  assert.equal(
    database.prepare("SELECT label FROM station_runtime_probe WHERE label = ?").get("missing"),
    undefined,
  );

  if (action === "upgrade-write") {
    const result = database
      .prepare("INSERT INTO station_runtime_probe (label, value) VALUES (?, ?)")
      .run(expectedLabel, roundTripInteger);
    assert.equal(result.changes, 1);
    assert.equal(typeof result.changes, "number");
    assert.ok(
      typeof result.lastInsertRowid === "number" || typeof result.lastInsertRowid === "bigint",
    );
    assert.equal(Number(result.lastInsertRowid), 1);

    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });
    assert.deepEqual(
      await persistence.createSessionGroup({
        id: `group-${expectedLabel}`,
        projectId: "project-cross-runtime",
        name: "Cross-runtime parent",
        initialMembers: [
          {
            sessionId: `session-${expectedLabel}`,
            projectId: "project-cross-runtime",
            expectedGroupId: null,
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      {
        ok: true,
        groups: [
          {
            id: `group-${expectedLabel}`,
            projectId: "project-cross-runtime",
            name: "Cross-runtime parent",
            sessionIds: [`session-${expectedLabel}`],
            version: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    );
    await persistence.createSessionGroup({
      id: `child-${expectedLabel}`,
      projectId: "project-cross-runtime",
      name: "Cross-runtime child",
      parentGroupId: `group-${expectedLabel}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await persistence.renameSessionGroup({
      id: `group-${expectedLabel}`,
      expectedVersion: 1,
      name: "Cross-runtime renamed",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
  }

  const row = database
    .prepare("SELECT label, value FROM station_runtime_probe WHERE label = ?")
    .get(expectedLabel);
  assert.equal(row?.label, expectedLabel);
  assert.equal(row?.value, roundTripInteger);

  const persistence = createSqliteObserverPersistence({ sqlite });
  assert.deepEqual(await persistence.listSessionGroups(), [
    {
      id: `group-${expectedLabel}`,
      projectId: "project-cross-runtime",
      name: "Cross-runtime renamed",
      sessionIds: [`session-${expectedLabel}`],
      version: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    },
    {
      id: `child-${expectedLabel}`,
      projectId: "project-cross-runtime",
      name: "Cross-runtime child",
      sessionIds: [],
      parentGroupId: `group-${expectedLabel}`,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
} finally {
  sqlite.close();
}
