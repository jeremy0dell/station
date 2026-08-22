import { z } from "zod";

export type CodexHookLockDatabase = {
  exec(sql: string): void;
  close(): void;
};

export type CodexHookLockDatabaseOpener = (
  path: string,
) => CodexHookLockDatabase | Promise<CodexHookLockDatabase>;

type NativeSqliteDatabase = {
  exec(sql: string): void;
  close(): void;
};

type NativeSqliteConstructor = new (path: string) => NativeSqliteDatabase;

declare const Bun: object;

const SqliteBusyErrorSchema = z.union([
  z.object({ code: z.literal("ERR_SQLITE_ERROR"), errcode: z.literal(5) }),
  z.object({ code: z.literal("SQLITE_BUSY"), errno: z.literal(5) }),
]);

let sqliteDatabaseConstructorPromise: Promise<NativeSqliteConstructor> | undefined;

export async function openCodexHookLockDatabase(path: string): Promise<CodexHookLockDatabase> {
  const SqliteDatabase = await sqliteDatabaseConstructor();
  return new SqliteDatabase(path);
}

export function isCodexHookLockBusy(cause: unknown): boolean {
  return SqliteBusyErrorSchema.safeParse(cause).success;
}

function sqliteDatabaseConstructor(): Promise<NativeSqliteConstructor> {
  sqliteDatabaseConstructorPromise ??=
    typeof Bun !== "undefined"
      ? // @ts-expect-error bun:sqlite is available only in the Bun runtime selected by this branch.
        import("bun:sqlite").then((module) => module.Database as NativeSqliteConstructor)
      : import("node:sqlite").then(
          (module) => module.DatabaseSync as unknown as NativeSqliteConstructor,
        );
  return sqliteDatabaseConstructorPromise;
}
