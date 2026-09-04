import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type StationBuildIdentity,
  StationBuildIdentitySchema,
} from "@station/contracts/build-identity";

declare const STATION_BUILD_VERSION: string;
declare const STATION_BUILD_COMPILED: boolean;
declare const STATION_BUILD_IDENTITY: string;

const OBSERVER_BUILD_IDENTITY_MARKER = /\+(?:[0-9A-Za-z-]+\.)*station\./u;
const OBSERVER_BUILD_IDENTITY_PATTERN = /^(.+)([+.])station\.([0-9a-f]{64})$/u;
const verifiedSourceBuildIdentitySlot = Symbol.for(
  "@station/runtime/verified-source-build-identity",
);
const verifyingSourceBuildIdentitySlot = Symbol.for(
  "@station/runtime/verifying-source-build-identity",
);

export type StationBuildInfo = {
  version: string;
  compiled: boolean;
  /** Immutable content identity shared by source and packaged artifacts from one build. */
  buildIdentity: StationBuildIdentity;
};

/**
 * Returns compiled identity or one source identity verified for the OS process lifetime,
 * including Bun hot reloads that replace the module registry.
 */
export function stationBuildInfo(): StationBuildInfo {
  return {
    version: stationBuildVersion(),
    compiled: isCompiledBinary(),
    buildIdentity:
      typeof STATION_BUILD_IDENTITY === "undefined"
        ? sourceBuildIdentity()
        : STATION_BUILD_IDENTITY,
  };
}

/**
 * Returns exact build information after asynchronous source admission, allowing callers to overlap
 * content verification with independent module loading without executing against stale outputs.
 */
export async function stationBuildInfoAsync(): Promise<StationBuildInfo> {
  if (isCompiledBinary()) return stationBuildInfo();
  return {
    version: stationBuildVersion(),
    compiled: false,
    buildIdentity: await sourceBuildIdentityAsync(),
  };
}

/** Encodes immutable identity as reserved SemVer metadata for Observer handoff evidence. */
export function stationObserverBuildVersion(info: StationBuildInfo = stationBuildInfo()): string {
  if (!StationBuildIdentitySchema.safeParse(info.buildIdentity).success) {
    throw new Error("Station build identity must be 64 lowercase hexadecimal characters.");
  }
  if (hasStationObserverBuildIdentityMarker(info.version)) {
    throw new Error("Station display version must not use reserved station build metadata.");
  }
  const separator = info.version.includes("+") ? "." : "+";
  return `${info.version}${separator}station.${info.buildIdentity}`;
}

/** Splits Station's reserved Observer identity suffix from the user-visible version. */
export function parseStationObserverBuildVersion(selector: string): {
  version: string;
  buildIdentity?: string;
} {
  const match = OBSERVER_BUILD_IDENTITY_PATTERN.exec(selector);
  if (match === null) return { version: selector };
  const [, version, separator, buildIdentity] = match;
  if (
    version === undefined ||
    separator === undefined ||
    buildIdentity === undefined ||
    hasStationObserverBuildIdentityMarker(version) ||
    (separator === "+" && version.includes("+")) ||
    (separator === "." && !version.includes("+"))
  ) {
    return { version: selector };
  }
  return { version, buildIdentity };
}

/** Detects Station's reserved metadata namespace even when its identity is malformed. */
export function hasStationObserverBuildIdentityMarker(selector: string): boolean {
  return OBSERVER_BUILD_IDENTITY_MARKER.test(selector);
}

export function isCompiledBinary(): boolean {
  return typeof STATION_BUILD_COMPILED === "undefined" ? false : STATION_BUILD_COMPILED;
}

function stationBuildVersion(): string {
  return typeof STATION_BUILD_VERSION === "undefined"
    ? "0.0.0-pre-alpha.14.7"
    : STATION_BUILD_VERSION;
}

function sourceBuildIdentity(): string {
  const processSlots = globalThis as typeof globalThis & Record<symbol, string | undefined>;
  const verifiedIdentity = processSlots[verifiedSourceBuildIdentitySlot];
  if (verifiedIdentity !== undefined) {
    return verifiedIdentity;
  }
  const evidence = readSourceBuildIdentityEvidence();
  try {
    execFileSync(
      process.execPath,
      [join(evidence.root, "scripts", "build-identity.mjs"), "--verify", evidence.identity],
      {
        cwd: evidence.root,
        stdio: "ignore",
      },
    );
  } catch (error) {
    throw staleSourceBuildIdentityError(evidence.path, error);
  }
  processSlots[verifiedSourceBuildIdentitySlot] = evidence.identity;
  return evidence.identity;
}

async function sourceBuildIdentityAsync(): Promise<StationBuildIdentity> {
  const verifiedSlots = globalThis as typeof globalThis & Record<symbol, string | undefined>;
  const verifiedIdentity = verifiedSlots[verifiedSourceBuildIdentitySlot];
  if (verifiedIdentity !== undefined) return StationBuildIdentitySchema.parse(verifiedIdentity);

  const pendingSlots = globalThis as typeof globalThis &
    Record<symbol, Promise<StationBuildIdentity> | undefined>;
  const existing = pendingSlots[verifyingSourceBuildIdentitySlot];
  if (existing !== undefined) return existing;

  const verification = verifySourceBuildIdentityAsync();
  pendingSlots[verifyingSourceBuildIdentitySlot] = verification;
  try {
    const identity = await verification;
    verifiedSlots[verifiedSourceBuildIdentitySlot] = identity;
    return identity;
  } finally {
    if (pendingSlots[verifyingSourceBuildIdentitySlot] === verification) {
      Reflect.deleteProperty(pendingSlots, verifyingSourceBuildIdentitySlot);
    }
  }
}

async function verifySourceBuildIdentityAsync(): Promise<StationBuildIdentity> {
  const evidence = readSourceBuildIdentityEvidence();
  try {
    await new Promise<void>((resolveVerification, rejectVerification) => {
      execFile(
        process.execPath,
        [join(evidence.root, "scripts", "build-identity.mjs"), "--verify", evidence.identity],
        { cwd: evidence.root },
        (error) => {
          if (error === null) resolveVerification();
          else rejectVerification(error);
        },
      );
    });
  } catch (error) {
    throw staleSourceBuildIdentityError(evidence.path, error);
  }
  return evidence.identity;
}

function readSourceBuildIdentityEvidence(): {
  identity: StationBuildIdentity;
  path: string;
  root: string;
} {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const root = join(moduleDirectory, "..", "..", "..");
  const path =
    basename(moduleDirectory) === "src"
      ? join(moduleDirectory, "..", "dist", "station-build-id")
      : join(moduleDirectory, "station-build-id");
  let rawIdentity: string;
  try {
    rawIdentity = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Station build identity is missing at ${path}. Run bun run build.`, {
        cause: error,
      });
    }
    throw error;
  }
  const parsed = StationBuildIdentitySchema.safeParse(rawIdentity);
  if (!parsed.success) {
    throw new Error(`Station build identity at ${path} is invalid. Run bun run build.`);
  }
  return { identity: parsed.data, path, root };
}

function staleSourceBuildIdentityError(path: string, cause: unknown): Error {
  return new Error(
    `Station build identity at ${path} does not match the current checkout and production outputs. Run bun run build.`,
    { cause },
  );
}
