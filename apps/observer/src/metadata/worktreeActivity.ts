import type { StationSnapshot } from "@station/contracts";

/**
 * A row with an attached terminal or agent is one a person or agent is working in now.
 * Metadata refresh reads git and GitHub state for these rows on every pass; other rows wait longer.
 */
export function isActiveWorktreeRow(row: StationSnapshot["rows"][number]): boolean {
  return row.terminal !== undefined || row.agent !== undefined;
}
