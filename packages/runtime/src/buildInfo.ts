import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const STATION_BUILD_VERSION: string;
declare const STATION_BUILD_COMPILED: boolean;
declare const STATION_BUILD_IDENTITY: string;

const BUILD_IDENTITY_PATTERN = /^[0-9a-f]{64}$/u;
const OBSERVER_BUILD_IDENTITY_MARKER = /\+(?:[0-9A-Za-z-]+\.)*station\./u;
const OBSERVER_BUILD_IDENTITY_PATTERN = /^(.+)([+.])station\.([0-9a-f]{64})$/u;
const verifiedSourceBuildIdentitySlot = Symbol.for(
  "@station/runtime/verified-source-build-identity",
);

export type StationBuildInfo = {
  version: string;
  compiled: boolean;
  /** Immutable content identity shared by source and packaged artifacts from one build. */
  buildIdentity: string;
};

/**
 * Returns compiled identity or one source identity verified for the OS process lifetime,
 * including Bun hot reloads that replace the module registry.
 */
export function stationBuildInfo(): StationBuildInfo {
  return {
    version: typeof STATION_BUILD_VERSION === "undefined" ? "0.7.1-rc.3" : STATION_BUILD_VERSION,
    compiled: isCompiledBinary(),
    buildIdentity:
      typeof STATION_BUILD_IDENTITY === "undefined"
        ? sourceBuildIdentity()
        : STATION_BUILD_IDENTITY,
  };
}

/** Encodes immutable identity as reserved SemVer metadata for Observer handoff evidence. */
export function stationObserverBuildVersion(info: StationBuildInfo = stationBuildInfo()): string {
  if (!BUILD_IDENTITY_PATTERN.test(info.buildIdentity)) {
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

function sourceBuildIdentity(): string {
  const processSlots = globalThis as typeof globalThis & Record<symbol, string | undefined>;
  const verifiedIdentity = processSlots[verifiedSourceBuildIdentitySlot];
  if (verifiedIdentity !== undefined) {
    return verifiedIdentity;
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const root = join(moduleDirectory, "..", "..", "..");
  const path =
    basename(moduleDirectory) === "src"
      ? join(moduleDirectory, "..", "dist", "station-build-id")
      : join(moduleDirectory, "station-build-id");
  let identity: string;
  try {
    identity = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Station build identity is missing at ${path}. Run pnpm build.`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!BUILD_IDENTITY_PATTERN.test(identity)) {
    throw new Error(`Station build identity at ${path} is invalid. Run pnpm build.`);
  }
  try {
    execFileSync(
      process.execPath,
      [join(root, "scripts", "build-identity.mjs"), "--verify", identity],
      {
        cwd: root,
        stdio: "ignore",
      },
    );
  } catch (error) {
    throw new Error(
      `Station build identity at ${path} does not match the current checkout and production outputs. Run pnpm build.`,
      { cause: error },
    );
  }
  processSlots[verifiedSourceBuildIdentitySlot] = identity;
  return identity;
}
