import type { StationSnapshot } from "@station/contracts";
import { selectFleetSummary } from "../selectors/fleetSummary.js";
import type { TopRowWidgetView } from "./types.js";

/**
 * Fill in snapshot-derived widgets (fleet / open-PR counts) right before
 * render, where the snapshot lives. Without a snapshot they drop out of the
 * strip rather than painting stale or empty text.
 */
export function resolveTopRowWidgets(
  widgets: readonly TopRowWidgetView[],
  snapshot: StationSnapshot | undefined,
): TopRowWidgetView[] {
  return widgets.flatMap((widget) => {
    if (widget.data === undefined) {
      return [widget];
    }
    if (snapshot === undefined) {
      return [];
    }
    if (widget.data === "fleet") {
      const fleet = selectFleetSummary(snapshot);
      const live = fleet.working + fleet.ready + fleet.needsYou + fleet.idle + fleet.starting;
      return [{ ...widget, text: `${live} ${plural(live, "agent")}` }];
    }
    const open = snapshot.rows.filter((row) => {
      const state = row.worktree.pr?.state;
      return state === "open" || state === "draft";
    }).length;
    return [
      {
        ...widget,
        text: `${open} open ${plural(open, "PR")}`,
        compact: `${open} ${plural(open, "PR")}`,
      },
    ];
  });
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
