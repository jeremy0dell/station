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
const PsProcessRowSchema = z
  .object({
    pid: z.number().int().positive(),
    ppid: z.number().int().nonnegative(),
    tty: PsTtySchema.nullable(),
  })
  .strict();
const PsNoTtySchema = z.enum(["?", "??", "-"]);
const ErrorCodeSchema = z.looseObject({ code: z.string() });
const MAX_TTY_ANCESTOR_DEPTH = 16;

type PsProcessRow = z.infer<typeof PsProcessRowSchema>;
type LegacyTtyAnchor =
  | { kind: "self"; pid: number; tty: string }
  | { kind: "ancestor"; pid: number; tty: string; chain: PsProcessRow[] };

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

/**
 * Corroborates legacy same-TTY evidence against the renderer or its nearest bounded
 * controlling-TTY ancestor, failing closed if ancestry or device identity cannot be revalidated.
 */
export function legacyOwnerPossible(
  stdinIdentity: StationTtyIdentity,
  deps: StationTtyOwnershipDeps,
): boolean | undefined {
  try {
    const anchor = findLegacyTtyAnchor(deps);
    const ttyPath = join("/dev", anchor.tty);
    const controllingTtyIdentity = ttyIdentity(deps.platform, deps.readTtyPathStat(ttyPath));
    if (!sameIdentity(stdinIdentity, controllingTtyIdentity)) return undefined;

    const output = deps.runPs(["-t", anchor.tty, "-o", "pid=,tty=,command="]);
    if (!output.endsWith("\n")) return undefined;
    const rows = output.split("\n").filter(Boolean).map(parsePsRow);
    if (!rows.some((row) => row.pid === anchor.pid && row.tty === anchor.tty)) return undefined;
    if (rows.some((row) => row.tty !== anchor.tty)) return undefined;
    if (!revalidateLegacyTtyAnchor(anchor, deps)) return undefined;

    const revalidatedTtyIdentity = ttyIdentity(deps.platform, deps.readTtyPathStat(ttyPath));
    if (
      !sameIdentity(stdinIdentity, revalidatedTtyIdentity) ||
      !sameIdentity(controllingTtyIdentity, revalidatedTtyIdentity)
    ) {
      return undefined;
    }
    return rows.some((row) => row.pid !== anchor.pid && looksLikeLegacyStation(row.command));
  } catch {
    return undefined;
  }
}

function findLegacyTtyAnchor(deps: StationTtyOwnershipDeps): LegacyTtyAnchor {
  const selfTty = readProcessTty(deps.selfPid, deps);
  if (selfTty !== null) return { kind: "self", pid: deps.selfPid, tty: selfTty };

  let current = readProcessRow(deps.selfPid, deps);
  if (current.tty !== null) throw new Error("Renderer controlling TTY changed.");
  const chain = [current];
  const visited = new Set([current.pid]);
  for (let depth = 0; depth < MAX_TTY_ANCESTOR_DEPTH; depth += 1) {
    if (current.ppid === 0 || visited.has(current.ppid)) {
      throw new Error("TTY ancestry is missing or cyclic.");
    }
    const parent = readProcessRow(current.ppid, deps);
    visited.add(parent.pid);
    chain.push(parent);
    if (parent.tty !== null) {
      return { kind: "ancestor", pid: parent.pid, tty: parent.tty, chain };
    }
    current = parent;
  }
  throw new Error("TTY ancestry exceeded its bound.");
}

function revalidateLegacyTtyAnchor(
  anchor: LegacyTtyAnchor,
  deps: StationTtyOwnershipDeps,
): boolean {
  if (anchor.kind === "self") return readProcessTty(anchor.pid, deps) === anchor.tty;
  return anchor.chain.every((expected) => {
    const actual = readProcessRow(expected.pid, deps);
    return (
      actual.pid === expected.pid && actual.ppid === expected.ppid && actual.tty === expected.tty
    );
  });
}

function readProcessTty(pid: number, deps: StationTtyOwnershipDeps): string | null {
  const output = deps.runPs(["-p", String(pid), "-o", "tty="]);
  if (!output.endsWith("\n")) throw new Error("Truncated ps output.");
  const fields = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (fields.length !== 1) throw new Error("Malformed ps output.");
  return parsePsTty(fields[0] ?? "");
}

function readProcessRow(pid: number, deps: StationTtyOwnershipDeps): PsProcessRow {
  const output = deps.runPs(["-p", String(pid), "-o", "pid=,ppid=,tty="]);
  if (!output.endsWith("\n")) throw new Error("Truncated ps output.");
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length !== 1) throw new Error("Malformed ps output.");
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(lines[0] ?? "");
  if (match === null) throw new Error("Malformed ps output.");
  const row = PsProcessRowSchema.parse({
    pid: Number(match[1]),
    ppid: Number(match[2]),
    tty: parsePsTty(match[3] ?? ""),
  });
  if (row.pid !== pid) throw new Error("ps returned a different process.");
  return row;
}

function parsePsTty(value: string): string | null {
  if (PsNoTtySchema.safeParse(value).success) return null;
  return PsTtySchema.parse(value);
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
