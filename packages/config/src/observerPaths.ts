import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { StationConfig } from "./schema.js";

export type ObserverPaths = {
  stateDir: string;
  socketPath: string;
  dbPath: string;
  logDir: string;
  diagnosticsDir: string;
  hookSpoolDir: string;
};

export function resolveObserverPaths(config?: StationConfig, homeDir = homedir()): ObserverPaths {
  const stateDir = resolvePath(config?.observer?.stateDir ?? "~/.local/state/station", homeDir);
  const socketPath = resolveObserverSocketPath(config, stateDir, homeDir);
  return {
    stateDir,
    socketPath,
    dbPath: join(stateDir, "observer.sqlite"),
    logDir: join(stateDir, "logs"),
    diagnosticsDir: join(stateDir, "diagnostics"),
    hookSpoolDir: join(stateDir, "spool", "hooks"),
  };
}

/**
 * Socket for the standalone `station-station-host` daemon. Placed beside the
 * observer socket so the two daemons share one run directory (and inherit the
 * same XDG_RUNTIME_DIR placement). Liveness/identity for persistent Station
 * agents flows over this socket; it is not config-overridable on its own.
 */
export function stationHostSocketPath(config?: StationConfig, homeDir = homedir()): string {
  return join(dirname(resolveObserverPaths(config, homeDir).socketPath), "station-host.sock");
}

export function resolvePath(input: string, homeDir = homedir(), baseDir = process.cwd()): string {
  const expanded =
    input === "~" ? homeDir : input.startsWith("~/") ? join(homeDir, input.slice(2)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

function resolveObserverSocketPath(
  config: StationConfig | undefined,
  stateDir: string,
  homeDir: string,
): string {
  if (config?.observer?.socketPath !== undefined) {
    return resolvePath(config.observer.socketPath, homeDir);
  }

  if (process.env.XDG_RUNTIME_DIR !== undefined && process.env.XDG_RUNTIME_DIR.length > 0) {
    return join(process.env.XDG_RUNTIME_DIR, "station", "observer.sock");
  }

  return join(stateDir, "run", "observer.sock");
}
