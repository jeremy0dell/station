import { normalize } from "node:path";

/** Applies only known OS path aliases and refuses ambiguous lexical dot segments. */
export function applyObservedPathAliases(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (observedPathHasLexicalDotSegments(value)) {
    return value;
  }
  if (value.startsWith("/private/var/")) {
    return `/var/${value.slice("/private/var/".length)}`;
  }
  if (platform === "darwin" && (value === "/private/tmp" || value.startsWith("/private/tmp/"))) {
    return `/tmp${value.slice("/private/tmp".length)}`;
  }
  return value;
}

/** Detects lexical dot segments that make destructive and recovery comparisons fail closed. */
export function observedPathHasLexicalDotSegments(value: string): boolean {
  return value.split("/").some((segment) => segment === "." || segment === "..");
}

export function normalizeObservedPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalize(value);
  const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/g, "") : normalized;
  return applyObservedPathAliases(withoutTrailingSlash, platform);
}

/**
 * POLICY
 *
 * Treats provider-observed paths as identical only when their authorized aliases and lexical safety rules agree.
 */
export function sameObservedPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if ([left, right].some(observedPathHasLexicalDotSegments)) return false;
  return normalizeObservedPath(left, platform) === normalizeObservedPath(right, platform);
}

/**
 * POLICY
 *
 * Determines managed-path containment using the same authorized alias and lexical-safety identity as equality checks.
 */
export function observedPathIsSameOrInside(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if ([candidate, root].some(observedPathHasLexicalDotSegments)) return false;
  const normalizedCandidate = normalizeObservedPath(candidate, platform);
  const normalizedRoot = normalizeObservedPath(root, platform);
  if (normalizedCandidate === normalizedRoot) {
    return true;
  }
  if (normalizedRoot === "/") {
    return normalizedCandidate.startsWith("/");
  }
  return normalizedCandidate.startsWith(`${normalizedRoot}/`);
}
