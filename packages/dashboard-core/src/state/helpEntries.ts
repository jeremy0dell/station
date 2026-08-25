export type HelpEntryId = string;

/** Ordered semantic Help identities supplied by the owning presentation. */
export type HelpEntryOrderSource = {
  entryIds(): readonly HelpEntryId[];
};

export function adjacentHelpEntryId(
  source: HelpEntryOrderSource | undefined,
  currentId: HelpEntryId | undefined,
  direction: -1 | 1,
): HelpEntryId | undefined {
  const ids = source?.entryIds() ?? [];
  if (ids.length === 0) return undefined;
  if (currentId === undefined) return direction < 0 ? ids.at(-1) : ids[0];
  const current = ids.indexOf(currentId);
  if (current < 0) return direction < 0 ? ids.at(-1) : ids[0];
  return ids[Math.max(0, Math.min(ids.length - 1, current + direction))];
}

export function endpointHelpEntryId(
  source: HelpEntryOrderSource | undefined,
  endpoint: "first" | "last",
): HelpEntryId | undefined {
  const ids = source?.entryIds() ?? [];
  return endpoint === "first" ? ids[0] : ids.at(-1);
}
