import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import type { SafeError } from "@station/contracts";
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
  setTakeoverHandler(handler: () => void): void;
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
  effectiveUid: () => {
    if (process.geteuid === undefined) throw new Error("Effective UID is unavailable.");
    return process.geteuid();
  },
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
type Claim = { kind: "owned"; database: SqliteDatabase } | { kind: "busy" };
type Takeover = "accepted" | "refused" | "unavailable";
type OwnerState = {
  version: number;
  identity: StationTtyIdentity;
  ownership: StationTtyOwnership;
  clearTakeoverHandler(): void;
};
type GlobalSlots = typeof globalThis & { __stationTtyOwnership?: OwnerState };

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
    existing.clearTakeoverHandler();
    return { kind: "owned", ownership: existing.ownership };
  }

  let paths: Paths;
  let claim: Claim;
  try {
    paths = preparePaths(deps.rendezvousDirectory(uid), identity, uid);
    claim = tryClaim(paths.database);
  } catch {
    return refusal("claim-unavailable");
  }

  let tookOver = false;
  if (claim.kind === "busy") {
    const deadline = Date.now() + deps.takeoverTimeoutMs;
    const result = await requestTakeover(paths.socket);
    if (result !== "accepted") {
      return refusal(result === "refused" ? "takeover-refused" : "takeover-unavailable");
    }
    tookOver = true;
    while (claim.kind === "busy" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        claim = tryClaim(paths.database);
      } catch {
        return refusal("claim-unavailable");
      }
    }
    if (claim.kind === "busy") return refusal("takeover-timeout");
  }

  if (!tookOver) {
    const legacyOwner = legacyOwnerPossible(deps);
    if (legacyOwner !== false) {
      releaseDatabase(claim.database);
      return legacyOwner === true
        ? refusal("legacy-owner-possible")
        : refusal("claim-unavailable");
    }
  }

  try {
    const state = await createOwner(identity, paths, claim.database, uid, slots);
    slots.__stationTtyOwnership = state;
    return { kind: "owned", ownership: state.ownership };
  } catch {
    releaseDatabase(claim.database);
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
  assertPrivate(directory, uid, "directory", 0o700);
  const stem = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
  const database = join(directory, `${stem}.sqlite`);
  const socket = join(directory, `${stem}.sock`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(database, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertPrivate(database, uid, "file", 0o600);
  return { database, socket };
}

function assertPrivate(
  path: string,
  uid: number,
  type: "directory" | "file",
  mode: number,
): void {
  const stat = lstatSync(path);
  const correctType = type === "directory" ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !correctType || stat.uid !== uid || (stat.mode & 0o777) !== mode) {
    throw new Error(`Unsafe Station TTY ${type}.`);
  }
}

function tryClaim(path: string): Claim {
  let database: SqliteDatabase | undefined;
  const oldUmask = process.umask(0o077);
  try {
    database = new Database(path, { create: true, strict: true });
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN IMMEDIATE");
    return { kind: "owned", database };
  } catch (error) {
    database?.close(false);
    if (errorCode(error) === "SQLITE_BUSY") return { kind: "busy" };
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
): Promise<OwnerState> {
  await removeStaleSocket(paths.socket, uid);
  const sockets = new Set<Socket>();
  let takeoverHandler: (() => void) | undefined;
  let accepted = false;
  let released = false;
  let state: OwnerState;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    receiveTakeoverRequest(socket, () => {
      if (released) return socket.destroy();
      if (accepted || takeoverHandler === undefined) return socket.end(TAKEOVER_REFUSED);
      accepted = true;
      const acceptedHandler = takeoverHandler;
      socket.end(TAKEOVER_ACCEPTED, () => acceptedHandler?.());
    });
  });
  let socketStat: ReturnType<typeof lstatSync>;
  try {
    await listen(server, paths.socket);
    chmodSync(paths.socket, 0o600);
    socketStat = lstatSync(paths.socket);
    if (socketStat.isSymbolicLink() || !socketStat.isSocket() || socketStat.uid !== uid) {
      throw new Error("Unsafe Station TTY socket.");
    }
  } catch (error) {
    server.close();
    throw error;
  }

  const ownership: StationTtyOwnership = {
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
      if (slots.__stationTtyOwnership === state) slots.__stationTtyOwnership = undefined;
      releaseDatabase(database);
    },
  };
  state = {
    version: OWNER_VERSION,
    identity,
    ownership,
    clearTakeoverHandler: () => {
      takeoverHandler = undefined;
    },
  };
  return state;
}

function receiveTakeoverRequest(socket: Socket, accept: () => void): void {
  let buffer = Buffer.alloc(0);
  let scheduled = false;
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > MAX_FRAME_BYTES) return socket.destroy();
    if (!scheduled && buffer.includes(0x0a)) {
      scheduled = true;
      setTimeout(() => {
        if (parseFrame(buffer) === TAKEOVER_REQUEST) accept();
        else socket.destroy();
      }, 0);
    }
  });
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

function readFrame(socket: Socket): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
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
        finish();
      }
    });
    socket.once("end", () => finish(parseFrame(buffer)));
    socket.once("error", () => finish());
  });
}

function parseFrame(buffer: Buffer): string | undefined {
  const text = buffer.toString("utf8");
  if (text.indexOf("\n") !== text.length - 1) return undefined;
  return text;
}

async function removeStaleSocket(path: string, uid: number): Promise<void> {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isSocket() || before.uid !== uid) {
    throw new Error("Unsafe Station TTY socket path.");
  }
  const stale = await new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) =>
      resolve(errorCode(error) === "ECONNREFUSED" || errorCode(error) === "ENOENT"),
    );
  });
  if (!stale) throw new Error("Station TTY endpoint may be live.");
  const after = lstatSync(path);
  if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error("Station TTY endpoint changed during validation.");
  }
  unlinkSync(path);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

const unavailable = {
  code: "TUI_TTY_OWNERSHIP_UNAVAILABLE",
  message: "Station could not establish trusted ownership of this terminal.",
};
const refusalDetails = {
  "identity-unavailable": unavailable,
  "claim-unavailable": unavailable,
  "takeover-unavailable": unavailable,
  "legacy-owner-possible": {
    code: "TUI_TTY_LEGACY_OWNER_POSSIBLE",
    message: "A pre-upgrade Station-like process may already own this terminal.",
  },
  "takeover-refused": {
    code: "TUI_TTY_TAKEOVER_REFUSED",
    message: "The running Station refused cooperative terminal takeover.",
  },
  "takeover-timeout": {
    code: "TUI_TTY_TAKEOVER_TIMEOUT",
    message: "The running Station accepted shutdown but did not release this terminal in time.",
  },
} satisfies Record<StationTtyOwnershipRefusalReason, { code: string; message: string }>;

function refusal(
  reason: StationTtyOwnershipRefusalReason,
): Extract<StationTtyOwnershipResult, { kind: "refused" }> {
  const details = refusalDetails[reason];
  return {
    kind: "refused",
    reason,
    error: {
      tag: "TuiRuntimeError",
      ...details,
      hint:
        "Station sent no signal. Close the incumbent with Ctrl-Q. If necessary, inspect `ps -t \"$(tty | sed 's#^/dev/##')\" -o pid=,command=` and send `kill -TERM <independently-verified-station-pid>` yourself. Never delete the SQLite claim file.",
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return ErrorCodeSchema.safeParse(error).data?.code;
}
