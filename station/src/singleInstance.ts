import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import type { SafeError } from "@station/contracts";
import { probeUnixSocket } from "@station/protocol";
import { z } from "zod";

type SqliteDatabase = {
  exec(sql: string): void;
  close(throwOnError?: boolean): void;
};

const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (path: string, options: { create: boolean; strict: boolean }) => SqliteDatabase;
};

const TAKEOVER_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 500;
const POLL_INTERVAL_MS = 25;
const OWNER_VERSION = 1;
// The per-TTY path supplies identity; the literal distinguishes takeover from liveness probes.
const TAKEOVER_REQUEST = "takeover\n";
const TAKEOVER_ACCEPTED = "accepted\n";
const TAKEOVER_REFUSED = "refused\n";
const MAX_FRAME_BYTES = Buffer.byteLength(TAKEOVER_REQUEST);

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

export type StationTtyOwnershipRefusalReason =
  | "identity-unavailable"
  | "claim-unavailable"
  | "legacy-owner-possible"
  | "takeover-refused"
  | "takeover-unavailable"
  | "takeover-timeout";

export type StationTtyOwnershipResult =
  | { kind: "not-required"; reason: "stdin-not-tty" }
  | { kind: "owned"; ownership: StationTtyOwnership }
  | {
      kind: "refused";
      reason: StationTtyOwnershipRefusalReason;
      error: SafeError;
    };

/**
 * Holds the SQLite transaction and takeover endpoint for one stdin device.
 * HMR reuses both; release closes the endpoint before rolling back the claim,
 * after the renderer has already released raw stdin.
 */
export type StationTtyOwnership = {
  identity: StationTtyIdentity;
  setTakeoverHandler(handler?: () => void): void;
  release(): void;
};

type TtyStat = Pick<BigIntStats, "dev" | "rdev" | "ino" | "isCharacterDevice">;

export type StationTtyOwnershipDeps = {
  isStdinTty(): boolean;
  platform: NodeJS.Platform;
  readStdinStat(): TtyStat;
  effectiveUid(): number;
  rendezvousDirectory(uid: number): string;
  runPs(args: readonly string[]): string;
  selfPid: number;
  takeoverTimeoutMs: number;
};

const defaults: StationTtyOwnershipDeps = {
  isStdinTty: () => process.stdin.isTTY === true,
  platform: process.platform,
  readStdinStat: () => fstatSync(0, { bigint: true }),
  effectiveUid: () => process.geteuid!(),
  rendezvousDirectory: (uid) => `/tmp/station-tui-${uid}`,
  runPs: (args) => execFileSync("ps", [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }),
  selfPid: process.pid,
  takeoverTimeoutMs: TAKEOVER_TIMEOUT_MS,
};

const PsTtySchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine((tty) => tty !== "??");
const PsRowSchema = z
  .object({
    pid: z.number().int().positive(),
    tty: PsTtySchema,
    command: z.string().min(1).max(32_768),
  })
  .strict();
const ErrorCodeSchema = z.object({ code: z.string() }).passthrough();

type Paths = { database: string; socket: string };
type Takeover = "accepted" | "refused" | "unavailable";
type OwnedState = StationTtyOwnership & { version: number };
type GlobalSlots = typeof globalThis & { __stationTtyOwnership?: OwnedState };

/**
 * Fails closed while acquiring a per-device claim, requests one cooperative
 * takeover when contended, and must complete before OpenTUI enters raw mode.
 */
export async function acquireStationTtyOwnership(
  overrides: Partial<StationTtyOwnershipDeps> = {},
): Promise<StationTtyOwnershipResult> {
  const deps = { ...defaults, ...overrides };
  if (!deps.isStdinTty()) return { kind: "not-required", reason: "stdin-not-tty" };

  let identity: StationTtyIdentity;
  let uid: number;
  try {
    identity = ttyIdentity(deps.platform, deps.readStdinStat());
    uid = deps.effectiveUid();
  } catch {
    return refusal("identity-unavailable");
  }

  const slots = globalThis as GlobalSlots;
  const existing = slots.__stationTtyOwnership;
  if (existing !== undefined) {
    if (existing.version !== OWNER_VERSION || !sameIdentity(existing.identity, identity)) {
      return refusal("claim-unavailable");
    }
    // A reloaded module must not dispatch takeover into the disposed composition.
    existing.setTakeoverHandler();
    return { kind: "owned", ownership: existing };
  }

  let paths: Paths;
  let database: SqliteDatabase | undefined;
  try {
    paths = preparePaths(deps.rendezvousDirectory(uid), identity, uid);
    database = tryClaimDatabase(paths.database);
  } catch {
    return refusal("claim-unavailable");
  }

  const takeoverNeeded = database === undefined;
  if (takeoverNeeded) {
    const deadline = Date.now() + deps.takeoverTimeoutMs;
    const result = await requestTakeover(paths.socket);
    if (result !== "accepted") {
      return refusal(result === "refused" ? "takeover-refused" : "takeover-unavailable");
    }
    while (database === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        database = tryClaimDatabase(paths.database);
      } catch {
        return refusal("claim-unavailable");
      }
    }
  }
  if (database === undefined) return refusal("takeover-timeout");

  if (!takeoverNeeded) {
    const legacyOwner = legacyOwnerPossible(deps);
    if (legacyOwner !== false) {
      releaseDatabase(database);
      return refusal(legacyOwner ? "legacy-owner-possible" : "claim-unavailable");
    }
  }

  try {
    const ownership = await createOwner(identity, paths, database, uid, slots);
    slots.__stationTtyOwnership = ownership;
    return { kind: "owned", ownership };
  } catch {
    releaseDatabase(database);
    return refusal("claim-unavailable");
  }
}

/** Revalidates that stdin still names the device acquired before startup work. */
export function currentStdinMatchesStationTty(
  identity: StationTtyIdentity,
  overrides: Partial<StationTtyOwnershipDeps> = {},
): boolean {
  const deps = { ...defaults, ...overrides };
  try {
    return deps.isStdinTty() && sameIdentity(ttyIdentity(deps.platform, deps.readStdinStat()), identity);
  } catch {
    return false;
  }
}

export function stationTtyOwnershipUnavailableError(): SafeError {
  return refusal("identity-unavailable").error;
}

function ttyIdentity(platform: NodeJS.Platform, stat: TtyStat): StationTtyIdentity {
  if ((platform !== "darwin" && platform !== "linux") || !stat.isCharacterDevice()) {
    throw new Error("Unsupported stdin device.");
  }
  const decimal = (value: bigint) => BigInt.asUintN(64, value).toString(10);
  return { platform, dev: decimal(stat.dev), rdev: decimal(stat.rdev), ino: decimal(stat.ino) };
}

function sameIdentity(left: StationTtyIdentity, right: StationTtyIdentity): boolean {
  return (
    left.platform === right.platform &&
    left.dev === right.dev &&
    left.rdev === right.rdev &&
    left.ino === right.ino
  );
}

function preparePaths(directory: string, identity: StationTtyIdentity, uid: number): Paths {
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

function privatePathStat(
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

function tryClaimDatabase(path: string): SqliteDatabase | undefined {
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

function releaseDatabase(database: SqliteDatabase): void {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close(false);
  }
}

function legacyOwnerPossible(deps: StationTtyOwnershipDeps): boolean | undefined {
  try {
    const tty = PsTtySchema.parse(deps.runPs(["-p", String(deps.selfPid), "-o", "tty="]).trim());
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

async function createOwner(
  identity: StationTtyIdentity,
  paths: Paths,
  database: SqliteDatabase,
  uid: number,
  slots: GlobalSlots,
): Promise<OwnedState> {
  await removeStaleSocket(paths.socket, uid);
  const sockets = new Set<Socket>();
  let takeoverHandler: (() => void) | undefined;
  let accepted = false;
  let released = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void readFrame(socket, true).then((request) => {
      if (request !== TAKEOVER_REQUEST || released) return socket.destroy();
      if (accepted || takeoverHandler === undefined) return socket.end(TAKEOVER_REFUSED);
      accepted = true;
      const acceptedHandler = takeoverHandler;
      socket.end(TAKEOVER_ACCEPTED, () => acceptedHandler?.());
    });
  });
  let socketStat: Stats;
  try {
    await once(server.listen(paths.socket), "listening");
    chmodSync(paths.socket, 0o600);
    socketStat = privatePathStat(paths.socket, uid, "socket", 0o600);
  } catch (error) {
    server.close();
    throw error;
  }

  const ownership: OwnedState = {
    version: OWNER_VERSION,
    identity,
    setTakeoverHandler: (handler) => {
      if (!released) takeoverHandler = handler;
    },
    release: () => {
      if (released) return;
      released = true;
      takeoverHandler = undefined;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
      try {
        const socket = lstatSync(paths.socket);
        if (socket.isSocket() && socket.dev === socketStat.dev && socket.ino === socketStat.ino) {
          unlinkSync(paths.socket);
        }
      } catch {
        // The claim still releases; a successor validates the endpoint before removal.
      }
      if (slots.__stationTtyOwnership === ownership) slots.__stationTtyOwnership = undefined;
      releaseDatabase(database);
    },
  };
  return ownership;
}

async function requestTakeover(path: string): Promise<Takeover> {
  const socket = createConnection(path);
  socket.once("connect", () => socket.write(TAKEOVER_REQUEST));
  const response = await readFrame(socket);
  socket.destroy();
  if (response === TAKEOVER_ACCEPTED) return "accepted";
  if (response === TAKEOVER_REFUSED) return "refused";
  return "unavailable";
}

function readFrame(socket: Socket, settleOnNewline = false): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let newlineScheduled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      resolve(value);
    };
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
      socket.destroy();
      finish();
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_FRAME_BYTES) {
        socket.destroy();
        return finish();
      }
      if (settleOnNewline && !newlineScheduled && buffer.includes(0x0a)) {
        newlineScheduled = true;
        setTimeout(() => finish(parseFrame(buffer)), 0);
      }
    });
    socket.once("end", () => finish(parseFrame(buffer)));
    socket.once("error", () => finish());
  });
}

function parseFrame(buffer: Buffer): string | undefined {
  const text = buffer.toString("utf8");
  return text.indexOf("\n") === text.length - 1 ? text : undefined;
}

async function removeStaleSocket(path: string, uid: number): Promise<void> {
  let before: Stats;
  try {
    before = privatePathStat(path, uid, "socket", 0o600);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const probe = await probeUnixSocket(path, { timeoutMs: REQUEST_TIMEOUT_MS });
  if (probe.status === "absent") return;
  if (probe.status !== "stale") throw new Error("Station TTY endpoint may be live.");
  const after = lstatSync(path);
  if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error("Station TTY endpoint changed during validation.");
  }
  unlinkSync(path);
}

const unavailable = [
  "TUI_TTY_OWNERSHIP_UNAVAILABLE",
  "Station could not establish trusted ownership of this terminal.",
] as const;
const refusalDetails = {
  "identity-unavailable": unavailable,
  "claim-unavailable": unavailable,
  "takeover-unavailable": unavailable,
  "legacy-owner-possible": [
    "TUI_TTY_LEGACY_OWNER_POSSIBLE",
    "A pre-upgrade Station-like process may already own this terminal.",
  ],
  "takeover-refused": [
    "TUI_TTY_TAKEOVER_REFUSED",
    "The running Station refused cooperative terminal takeover.",
  ],
  "takeover-timeout": [
    "TUI_TTY_TAKEOVER_TIMEOUT",
    "The running Station accepted shutdown but did not release this terminal in time.",
  ],
} as const satisfies Record<StationTtyOwnershipRefusalReason, readonly [string, string]>;

function refusal(
  reason: StationTtyOwnershipRefusalReason,
): Extract<StationTtyOwnershipResult, { kind: "refused" }> {
  const [code, message] = refusalDetails[reason];
  return {
    kind: "refused",
    reason,
    error: {
      tag: "TuiRuntimeError",
      code,
      message,
      hint:
        "Station sent no signal. Close the incumbent with Ctrl-Q. If necessary, inspect `ps -t \"$(tty | sed 's#^/dev/##')\" -o pid=,command=` and send `kill -TERM <independently-verified-station-pid>` yourself. Never delete the SQLite claim file.",
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return ErrorCodeSchema.safeParse(error).data?.code;
}
