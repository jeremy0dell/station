const stationBuildIdentityPattern = /^[0-9a-f]{64}$/u;
const stationObserverBuildIdentityMarker = /\+(?:[0-9A-Za-z-]+\.)*station\./u;
const stationObserverBuildIdentityPattern = /^(.+)([+.])station\.([0-9a-f]{64})$/u;

export type StationObserverBuildIdentity = {
  version: string;
  buildIdentity?: string;
};

/** Encodes one immutable Station build identity into the reserved Observer selector namespace. */
export function formatStationObserverBuildIdentity(version: string, buildIdentity: string): string {
  if (!stationBuildIdentityPattern.test(buildIdentity)) {
    throw new Error("Station build identity must be 64 lowercase hexadecimal characters.");
  }
  if (hasStationObserverBuildIdentityMarker(version)) {
    throw new Error("Station display version must not use reserved station build metadata.");
  }
  const separator = version.includes("+") ? "." : "+";
  return `${version}${separator}station.${buildIdentity}`;
}

/** Strictly splits Station's reserved Observer identity suffix from its display version. */
export function parseStationObserverBuildIdentity(selector: string): StationObserverBuildIdentity {
  const match = stationObserverBuildIdentityPattern.exec(selector);
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

/** Detects the reserved Station metadata namespace even when the selector is malformed. */
export function hasStationObserverBuildIdentityMarker(selector: string): boolean {
  return stationObserverBuildIdentityMarker.test(selector);
}
