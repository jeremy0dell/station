type HelpScrollChromeInput = {
  readonly allIds: readonly string[];
  readonly visibleIds: readonly string[] | undefined;
  readonly panelWidth: number;
};

type HelpContinuationCounts = {
  readonly above: number;
  readonly below: number;
};

/** Formats the Help continuation cue from the semantic visible window and rendered panel width. */
export function helpScrollChrome({
  allIds,
  visibleIds,
  panelWidth,
}: HelpScrollChromeInput): string {
  const counts = helpContinuationCounts(allIds, visibleIds);
  if (panelWidth < 48) {
    if (counts.above > 0 && counts.below > 0) return `↑${counts.above}/↓${counts.below}`;
    if (counts.above > 0) return `↑${counts.above}`;
    if (counts.below > 0) return `↓${counts.below}`;
    return "all";
  }
  if (counts.above > 0 && counts.below > 0) {
    return `↑ ${counts.above} above · ↓ ${counts.below} below`;
  }
  if (counts.above > 0) return `↑ ${counts.above} above`;
  if (counts.below > 0) return `↓ ${counts.below} below`;
  return "all visible";
}

function helpContinuationCounts(
  allIds: readonly string[],
  visibleIds: readonly string[] | undefined,
): HelpContinuationCounts {
  const firstId = visibleIds?.[0];
  const lastId = visibleIds?.at(-1);
  const firstIndex = firstId === undefined ? -1 : allIds.indexOf(firstId);
  const lastIndex = lastId === undefined ? -1 : allIds.indexOf(lastId);
  return {
    above: firstIndex < 0 ? 0 : firstIndex,
    below: lastIndex < 0 ? 0 : Math.max(0, allIds.length - lastIndex - 1),
  };
}
