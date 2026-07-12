import { describe, expect, it } from "vitest";
import { isSqliteBusyError, openSqlDatabase } from "../../src/sqlite/driver";

describe("SQLite driver", () => {
  it("normalizes Node SQLite statements to the shared contract", () => {
    const database = openSqlDatabase(":memory:");

    try {
      database.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");

      const result = database.prepare("INSERT INTO values_table (value) VALUES (?)").run(42);

      expect(result).toEqual({ changes: 1, lastInsertRowid: 1 });
      expect(
        database.prepare("SELECT value FROM values_table WHERE id = ?").get(999),
      ).toBeUndefined();
      expect(database.prepare("SELECT value FROM values_table ORDER BY id").all()).toEqual([
        { value: 42 },
      ]);
    } finally {
      database.close();
    }
  });

  it.each([
    [{ code: "ERR_SQLITE_ERROR", errcode: 5 }, true],
    [{ code: "SQLITE_BUSY", errno: 5 }, true],
    [{ code: "ERR_SQLITE_ERROR", errcode: 6 }, false],
    [{ code: "SQLITE_BUSY", errno: 6 }, false],
    [{ code: "SQLITE_BUSY", errcode: 5 }, false],
    [{ code: "ERR_SQLITE_ERROR", errno: 5 }, false],
    [{ code: "SQLITE_BUSY" }, false],
    [new Error("busy"), false],
  ])("classifies only verified native busy error shapes", (error, expected) => {
    expect(isSqliteBusyError(error)).toBe(expected);
  });
});
