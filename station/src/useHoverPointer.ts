import { useRenderer } from "@opentui/react";
import { useCallback, useEffect, useRef } from "react";

// The mouse-pointer shape is a terminal-wide OSC escape, so every hover region
// shares one desired state: "pointer" while any region is hovered, else
// "default". A ref-counted set of live regions (rather than a single "owner"
// slot) keeps moving between adjacent regions from flickering the shape and
// can't get wedged "pointer" if one region's leave is missed — the set is the
// authority and any correct add/remove re-derives the truth.
const hoveredRegions = new Set<object>();
let appliedPointer: "default" | "pointer" = "default";

function syncPointer(renderer: ReturnType<typeof useRenderer>): void {
  const want = hoveredRegions.size > 0 ? "pointer" : "default";
  if (want !== appliedPointer) {
    appliedPointer = want;
    renderer.setMousePointer(want);
  }
}

type HoverPointerOptions = {
  enabled?: boolean | undefined;
  onHoverChange?: ((hover: boolean) => void) | undefined;
};

export function useHoverPointer(options: HoverPointerOptions = {}) {
  const renderer = useRenderer();
  const region = useRef<object>({}); // stable per-instance identity for the hover set
  const hovered = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimer.current === undefined) {
      return;
    }
    clearTimeout(leaveTimer.current);
    leaveTimer.current = undefined;
  }, []);

  const activate = useCallback(() => {
    if (options.enabled === false) {
      return;
    }
    clearLeaveTimer();
    hoveredRegions.add(region.current);
    if (!hovered.current) {
      hovered.current = true;
      options.onHoverChange?.(true);
    }
    syncPointer(renderer);
  }, [clearLeaveTimer, options.enabled, options.onHoverChange, renderer]);

  const deactivate = useCallback(() => {
    clearLeaveTimer();
    // Defer the drop: during a morph/resize OpenTUI fires out->over across the
    // region's own children, and moving onto an adjacent region fires out->over
    // too. The follow-up `over` re-activates and cancels this timer, so the
    // shape only drops when the pointer has truly left every region.
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = undefined;
      hoveredRegions.delete(region.current);
      if (hovered.current) {
        hovered.current = false;
        options.onHoverChange?.(false);
      }
      syncPointer(renderer);
    }, 0);
  }, [clearLeaveTimer, options.onHoverChange, renderer]);

  useEffect(
    // Unmount-while-hovered (hot reload, state swap) never fires `out`; drop the
    // region so the pointer can't get stuck on for the whole terminal.
    () => () => {
      clearLeaveTimer();
      hoveredRegions.delete(region.current);
      syncPointer(renderer);
    },
    [clearLeaveTimer, renderer],
  );

  return {
    onMouseMove: activate,
    onMouseOut: deactivate,
    onMouseOver: activate,
  };
}
