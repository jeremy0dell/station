import { useEffect, useRef, useState } from "react";
import type { StationClientStateSource } from "@station/client";
import type { IslandCelebration } from "./layout.js";

export const CELEBRATION_MS = 4_000;

type SeenPr = { number: number; state: string };

/**
 * A just-merged PR to celebrate on the island, cleared after `ttlMs`.
 * Transition-only: the first snapshot seen, a row first appearing, or a row
 * whose PR was already merged never celebrates — a restart amid merged rows
 * stays quiet.
 */
export function useMergeCelebration(
  clientState: StationClientStateSource,
  ttlMs: number = CELEBRATION_MS,
): IslandCelebration | undefined {
  const [celebration, setCelebration] = useState<IslandCelebration | undefined>(undefined);
  const seen = useRef<Map<string, SeenPr> | undefined>(undefined);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): void => {
      const rows = clientState.getState().snapshot?.rows;
      if (rows === undefined) {
        return;
      }
      const prior = seen.current;
      const next = new Map<string, SeenPr>();
      let merged: IslandCelebration | undefined;
      for (const row of rows) {
        const pr = row.worktree.pr;
        if (pr === undefined) {
          continue;
        }
        const state = pr.state ?? "unknown";
        next.set(row.id, { number: pr.number, state });
        const before = prior?.get(row.id);
        if (
          state === "merged" &&
          before !== undefined &&
          before.number === pr.number &&
          before.state !== "merged"
        ) {
          merged = { prNumber: pr.number, ...(pr.title === undefined ? {} : { title: pr.title }) };
        }
      }
      seen.current = next;
      if (merged === undefined) {
        return;
      }
      setCelebration(merged);
      clearTimeout(timer);
      timer = setTimeout(() => setCelebration(undefined), ttlMs);
    };
    check();
    const unsubscribe = clientState.subscribe(check);
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [clientState, ttlMs]);

  return celebration;
}
