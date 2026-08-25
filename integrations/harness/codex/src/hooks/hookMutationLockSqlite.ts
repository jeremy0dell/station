import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export type CodexHookLockDatabase = {
  exec(sql: string): void;
  close(): void;
};

export type CodexHookLockDatabaseOpener = (
  path: string,
) => CodexHookLockDatabase | Promise<CodexHookLockDatabase>;

const SqliteBusyErrorSchema = z.union([
  z.object({ code: z.literal("ERR_SQLITE_ERROR"), errcode: z.literal(5) }),
  z.object({ code: z.literal("SQLITE_BUSY"), errno: z.literal(5) }),
]);

export async function openCodexHookLockDatabase(path: string): Promise<CodexHookLockDatabase> {
  return new DatabaseSync(path);
}

export function isCodexHookLockBusy(cause: unknown): boolean {
  return SqliteBusyErrorSchema.safeParse(cause).success;
}
