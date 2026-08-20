import { execFileSync } from "node:child_process";
import { fstatSync, statSync } from "node:fs";
import type { SafeError } from "@station/contracts";
import {
  legacyOwnerPossible,
  prepareClaimPaths,
  releaseDatabase,
  sameIdentity,
  tryClaimDatabase,
  ttyIdentity,
  type StationTtyIdentity,
  type StationTtyOwnershipDeps,
} from "./singleInstance/claim.js";
import {
  createOwner,
  OWNER_VERSION,
  requestTakeover,
  type StationTtyOwnership,
  type StationTtyOwnershipSlots,
} from "./singleInstance/protocol.js";

export type { StationTtyIdentity, StationTtyOwnershipDeps } from "./singleInstance/claim.js";
export type { StationTtyOwnership } from "./singleInstance/protocol.js";

const TAKEOVER_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 25;

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

const defaults: StationTtyOwnershipDeps = {
  isStdinTty: () => process.stdin.isTTY === true,
  platform: process.platform,
  readStdinStat: () => fstatSync(0, { bigint: true }),
  readTtyPathStat: (path) => statSync(path, { bigint: true }),
  effectiveUid: () => {
    if (process.geteuid === undefined) {
      throw new Error("Effective UID is unavailable on this platform.");
    }
    return process.geteuid();
  },
  rendezvousDirectory: (uid) => `/tmp/station-tui-${uid}`,
  runPs: (args) => execFileSync("ps", [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }),
  selfPid: process.pid,
  takeoverTimeoutMs: TAKEOVER_TIMEOUT_MS,
};

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

  const slots = globalThis as StationTtyOwnershipSlots;
  const existing = slots.__stationTtyOwnership;
  if (existing !== undefined) {
    if (existing.version !== OWNER_VERSION || !sameIdentity(existing.identity, identity)) {
      return refusal("claim-unavailable");
    }
    // A reloaded module must not dispatch takeover into the disposed composition.
    existing.setTakeoverHandler();
    return { kind: "owned", ownership: existing };
  }

  let paths: ReturnType<typeof prepareClaimPaths>;
  let database: ReturnType<typeof tryClaimDatabase>;
  try {
    paths = prepareClaimPaths(deps.rendezvousDirectory(uid), identity, uid);
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
    const legacyOwner = legacyOwnerPossible(identity, deps);
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
  return ownershipError("identity-unavailable");
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
  return { kind: "refused", reason, error: ownershipError(reason) };
}

function ownershipError(reason: StationTtyOwnershipRefusalReason): SafeError {
  const [code, message] = refusalDetails[reason];
  return {
    tag: "TuiRuntimeError",
    code,
    message,
    hint:
      "Station sent no signal. Close the incumbent with Ctrl-Q. If necessary, inspect `ps -t \"$(tty | sed 's#^/dev/##')\" -o pid=,command=` and send `kill -TERM <independently-verified-station-pid>` yourself. Never delete the SQLite claim file.",
  };
}
