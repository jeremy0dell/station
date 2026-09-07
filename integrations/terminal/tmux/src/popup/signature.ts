import { stationObserverBuildVersion } from "@station/runtime/build-info";

/** Identifies the exact renderer command and build allowed to own the persistent session. */
export function persistentPopupSignature(
  tuiCommand: string,
  buildVersion = stationObserverBuildVersion(),
  focusClientId?: string,
): string {
  const focusIdentity = focusClientId === undefined ? "" : `:client=${focusClientId}`;
  return `v2:${buildVersion}:${tuiCommand}${focusIdentity}`;
}
