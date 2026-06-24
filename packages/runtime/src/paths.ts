import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function pathIsSame(candidate: string, root: string): boolean {
  return normalizeLocalPath(candidate) === normalizeLocalPath(root);
}

export function pathIsSameOrInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeLocalPath(candidate);
  const normalizedRoot = normalizeLocalPath(root);
  if (normalizedCandidate === normalizedRoot) {
    return true;
  }
  if (normalizedRoot === "/") {
    return normalizedCandidate.startsWith("/");
  }
  return normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function normalizeLocalPath(value: string): string {
  const trimmed = value.trim();
  const withoutTrailingSlash = trimmed.length > 1 ? trimmed.replace(/\/+$/g, "") : trimmed;
  return withoutTrailingSlash.startsWith("/private/var/")
    ? `/var/${withoutTrailingSlash.slice("/private/var/".length)}`
    : withoutTrailingSlash;
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
