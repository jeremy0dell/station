import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { z } from "zod";

export type SqliteDatabase = {
  exec(sql: string): void;
  close(throwOnError?: boolean): void;
};

const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (path: string, options: { create: boolean; strict: boolean }) => SqliteDatabase;
};

/**
 * Identifies the actual stdin device from typed `fstat` metadata, not a display
 * TTY name or a process claim.
 */
export type StationTtyIdentity = {
  platform: "darwin" | "linux";
  dev: string;
  rdev: string;
  ino: string;
};

export type TtyStat = Pick<BigIntStats, "dev" | "rdev" | "ino" | "isCharacterDevice">;

export type StationTtyOwnershipDeps = {
  isStdinTty(): boolean;
  platform: NodeJS.Platform;
  readStdinStat(): TtyStat;
  readTtyPathStat(path: string): TtyStat;
  effectiveUid(): number;
  rendezvousDirectory(uid: number): string;
  runPs(args: readonly string[]): string;
  selfPid: number;
  takeoverTimeoutMs: number;
};

export type StationTtyClaimPaths = { database: string; socket: string };

const PsTtySchema = z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*|pts\/[0-9]+)$/);
const PsRowSchema = z
  .object({
    pid: z.number().int().positive(),
    tty: PsTtySchema,
    command: z.string().min(1).max(32_768),
  })
  .strict();
const ErrorCodeSchema = z.looseObject({ code: z.string() });

export function ttyIdentity(platform: NodeJS.Platform, stat: TtyStat): StationTtyIdentity {
  if ((platform !== "darwin" && platform !== "linux") || !stat.isCharacterDevice()) {
    throw new Error("Unsupported stdin device.");
  }
  const decimal = (value: bigint) => BigInt.asUintN(64, value).toString(10);
  return { platform, dev: decimal(stat.dev), rdev: decimal(stat.rdev), ino: decimal(stat.ino) };
}

export function sameIdentity(left: StationTtyIdentity, right: StationTtyIdentity): boolean {
  return (
    left.platform === right.platform &&
    left.dev === right.dev &&
    left.rdev === right.rdev &&
    left.ino === right.ino
  );
}

export function prepareClaimPaths(
  directory: string,
  identity: StationTtyIdentity,
  uid: number,
): StationTtyClaimPaths {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePathStat(directory, uid, "directory", 0o700);
  const stem = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
  const database = join(directory, `${stem}.sqlite`);
  const socket = join(directory, `${stem}.sock`);
  try {
    closeSync(openSync(database, "wx", 0o600));
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  privatePathStat(database, uid, "file", 0o600);
  return { database, socket };
}

export function privatePathStat(
  path: string,
  uid: number,
  type: "directory" | "file" | "socket",
  mode: number,
): Stats {
  const stat = lstatSync(path);
  const correctType =
    type === "directory" ? stat.isDirectory() : type === "file" ? stat.isFile() : stat.isSocket();
  if (stat.isSymbolicLink() || !correctType || stat.uid !== uid || (stat.mode & 0o777) !== mode) {
    throw new Error(`Unsafe Station TTY ${type}.`);
  }
  return stat;
}

export function tryClaimDatabase(path: string): SqliteDatabase | undefined {
  let database: SqliteDatabase | undefined;
  const oldUmask = process.umask(0o077);
  try {
    database = new Database(path, { create: true, strict: true });
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN IMMEDIATE");
    return database;
  } catch (error) {
    database?.close(false);
    if (errorCode(error) === "SQLITE_BUSY") return undefined;
    throw error;
  } finally {
    process.umask(oldUmask);
  }
}

export function releaseDatabase(database: SqliteDatabase): void {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close(false);
  }
}

export function legacyOwnerPossible(
  stdinIdentity: StationTtyIdentity,
  deps: StationTtyOwnershipDeps,
): boolean | undefined {
  try {
    const tty = PsTtySchema.parse(deps.runPs(["-p", String(deps.selfPid), "-o", "tty="]).trim());
    // `ps` reports the controlling TTY, which must match fd 0 before it can scope legacy evidence.
    const controllingTtyIdentity = ttyIdentity(
      deps.platform,
      deps.readTtyPathStat(join("/dev", tty)),
    );
    if (!sameIdentity(stdinIdentity, controllingTtyIdentity)) return undefined;
    const output = deps.runPs(["-t", tty, "-o", "pid=,tty=,command="]);
    if (!output.endsWith("\n")) return undefined;
    const rows = output.split("\n").filter(Boolean).map(parsePsRow);
    if (!rows.some((row) => row.pid === deps.selfPid && row.tty === tty)) return undefined;
    if (rows.some((row) => row.tty !== tty)) return undefined;
    return rows.some((row) => row.pid !== deps.selfPid && looksLikeLegacyStation(row.command));
  } catch {
    return undefined;
  }
}

function parsePsRow(line: string): z.infer<typeof PsRowSchema> {
  const match = /^\s*(\d+)\s+(\S+)\s+(.+\S)\s*$/.exec(line);
  if (match === null) throw new Error("Malformed ps output.");
  return PsRowSchema.parse({ pid: Number(match[1]), tty: match[2], command: match[3] });
}

function looksLikeLegacyStation(command: string): boolean {
  const argv = command.trim().split(/\s+/);
  const executable = basename(argv[0] ?? "");
  if (executable === "stn") return argv.length === 2 && argv[1] === "__tui";
  return (
    executable === "bun" &&
    argv.slice(1).some((argument) => /(?:^|\/)src\/main\.tsx$/.test(argument))
  );
}

export function errorCode(error: unknown): string | undefined {
  return ErrorCodeSchema.safeParse(error).data?.code;
}
