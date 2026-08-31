import { join } from "node:path";

/**
 * Mirrors the default observer socket resolution in
 * packages/config/src/observerPaths.ts: env override, then XDG_RUNTIME_DIR, then
 * the default state dir. Config-file socket paths are covered by the env override.
 */
export function resolveStationObserverSocketPath(
  env: Record<string, string | undefined>,
): string {
  const override = env.STATION_OBSERVER_SOCKET_PATH;
  if (override !== undefined && override.length > 0) {
    return override;
  }

  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (runtimeDir !== undefined && runtimeDir.length > 0) {
    return join(runtimeDir, "station", "observer.sock");
  }

  const home = env.HOME;
  if (home === undefined || home.length === 0) {
    throw new Error(
      "Cannot resolve the observer socket path: set STATION_OBSERVER_SOCKET_PATH or HOME.",
    );
  }

  return join(home, ".local", "state", "station", "run", "observer.sock");
}
