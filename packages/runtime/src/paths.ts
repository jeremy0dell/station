import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  applyObservedPathAliases,
  observedPathIsSameOrInside,
  sameObservedPath,
} from "@station/contracts";

export function pathIsSame(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return sameObservedPath(candidate, root, platform);
}

export function pathIsSameOrInside(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return observedPathIsSameOrInside(candidate, root, platform);
}

export function normalizeLocalPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = value.trim();
  const withoutTrailingSlash = trimmed.length > 1 ? trimmed.replace(/\/+$/g, "") : trimmed;
  return applyObservedPathAliases(withoutTrailingSlash, platform);
}

export function resolveLocalPath(
  input: string,
  homeDir = homedir(),
  baseDir = process.cwd(),
): string {
  const expanded =
    input === "~" ? homeDir : input.startsWith("~/") ? join(homeDir, input.slice(2)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

export function defaultStationStateDir(env = process.env, homeDir = homedir()): string {
  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.length > 0) {
    return join(env.XDG_STATE_HOME, "station");
  }
  return join(homeDir, ".local", "state", "station");
}
