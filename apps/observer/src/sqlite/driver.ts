import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

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

const SqliteBusyErrorSchema = z.union([
  z.object({ code: z.literal("ERR_SQLITE_ERROR"), errcode: z.literal(5) }),
  z.object({ code: z.literal("SQLITE_BUSY"), errno: z.literal(5) }),
]);

const SqliteDatabase = DatabaseSync as unknown as NativeSqliteConstructor;

export const openSqlDatabase = (path: string): SqlDatabase =>
  adaptDatabase(new SqliteDatabase(path));

export function isSqliteBusyError(error: unknown): boolean {
  return SqliteBusyErrorSchema.safeParse(error).success;
}

function adaptDatabase(database: NativeSqliteDatabase): SqlDatabase {
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
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
      };
    },
    close: () => database.close(),
  };
}
