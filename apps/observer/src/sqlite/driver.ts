export type SqlParam = string | number | bigint | Uint8Array | null;

export type SqlRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

export type SqlStatement = {
  run(...params: SqlParam[]): SqlRunResult;
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
};

export type SqlDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
};

type NativeSqliteRunResult = {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
};

type NativeSqliteStatement = {
  run(...params: SqlParam[]): NativeSqliteRunResult;
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
};

type NativeSqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): NativeSqliteStatement;
  close(): void;
};

type NativeSqliteConstructor = new (path: string) => NativeSqliteDatabase;

declare const Bun: object;

// Import exactly one driver: loading node:sqlite terminates Bun before fallback is possible.
const openSqlite =
  typeof Bun !== "undefined"
    ? // @ts-expect-error bun:sqlite is available only in the Bun runtime selected by this branch.
      adaptBunSqlite((await import("bun:sqlite")).Database)
    : adaptNodeSqlite((await import("node:sqlite")).DatabaseSync);

export const openSqlDatabase = (path: string): SqlDatabase => openSqlite(path);

function adaptNodeSqlite(Database: NativeSqliteConstructor): (path: string) => SqlDatabase {
  return (path) => adaptDatabase(new Database(path), false);
}

function adaptBunSqlite(Database: NativeSqliteConstructor): (path: string) => SqlDatabase {
  return (path) => adaptDatabase(new Database(path), true);
}

function adaptDatabase(database: NativeSqliteDatabase, normalizeMissingRow: boolean): SqlDatabase {
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        run: (...params) => {
          const result = statement.run(...params);
          return {
            changes: Number(result.changes),
            lastInsertRowid: result.lastInsertRowid,
          };
        },
        get: (...params) => {
          const row = statement.get(...params);
          return normalizeMissingRow && row === null ? undefined : row;
        },
        all: (...params) => statement.all(...params),
      };
    },
    close: () => database.close(),
  };
}
