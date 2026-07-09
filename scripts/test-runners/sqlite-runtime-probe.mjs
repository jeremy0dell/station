import assert from "node:assert/strict";

const [, , action, databasePath, expectedLabel] = process.argv;
assert.ok(action === "create" || action === "read", "Expected a create or read action.");
assert.ok(databasePath, "Expected a SQLite database path.");
assert.ok(expectedLabel, "Expected a probe label.");

const { migrations, openObserverSqlite } = await import(
  new URL("../../apps/observer/dist/internal.js", import.meta.url).href
);
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

  if (action === "create") {
    const result = database
      .prepare("INSERT INTO station_runtime_probe (label, value) VALUES (?, ?)")
      .run(expectedLabel, roundTripInteger);
    assert.equal(result.changes, 1);
    assert.equal(typeof result.changes, "number");
    assert.ok(
      typeof result.lastInsertRowid === "number" || typeof result.lastInsertRowid === "bigint",
    );
    assert.equal(Number(result.lastInsertRowid), 1);
  }

  const row = database
    .prepare("SELECT label, value FROM station_runtime_probe WHERE label = ?")
    .get(expectedLabel);
  assert.equal(row?.label, expectedLabel);
  assert.equal(row?.value, roundTripInteger);
} finally {
  sqlite.close();
}
