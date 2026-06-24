export function searchQueryForFilter(filter: string): string | undefined {
  const normalized = normalizedFilter(filter);
  if (normalized.length < 2 || pastedPathCandidate(normalized) !== undefined) {
    return undefined;
  }
  return normalized;
}

export function normalizedFilter(filter: string): string {
  return filter.trim();
}

export function pastedPathCandidate(filter: string): string | undefined {
  const value = filter.trim();
  if (value.length === 0) {
    return undefined;
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("/")) {
    return value;
  }
  return undefined;
}

export function normalizeProjectId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return normalized.length === 0 ? "project" : normalized;
}
