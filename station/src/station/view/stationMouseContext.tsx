// Mouse boundary plumbing: renderables dispatch {target, event}; Station input
// runtime routes it (routeMouse -> station bindings). Hit-testing and
// stopPropagation happen here. Default is no-op (golden tests don't need provider).
import { createContext, useCallback, useContext, useState } from "react";
import type { MouseEvent } from "@opentui/core";
import { scrollbarOffsetForTrackIndex } from "@station/dashboard-core/selectors";
import type { StationMouseTarget } from "../input/stationMouse.js";

export type StationMouseDispatch = (target: StationMouseTarget, event: MouseEvent) => void;

const StationMouseContext = createContext<StationMouseDispatch>(() => {});
const StationHoverContext = createContext(true);

export const StationMouseProvider = StationMouseContext.Provider;
export const StationHoverProvider = StationHoverContext.Provider;

export function useStationMouse(): StationMouseDispatch {
  return useContext(StationMouseContext);
}

export function useStationHoverEnabled(): boolean {
  return useContext(StationHoverContext);
}

export function useStationHoverState(): readonly [boolean, (hover: boolean) => void] {
  const enabled = useStationHoverEnabled();
  const [hover, setHoverState] = useState(false);
  const setHover = useCallback(
    (next: boolean) => {
      setHoverState(enabled && next);
    },
    [enabled],
  );
  return [enabled && hover, setHover] as const;
}

/** onMouseDown/onMouseScroll handlers for a target, stopping propagation so
 * outer surfaces (the body wheel area, Station's pane box) don't double-route. */
export function stationMouseProps(
  dispatch: StationMouseDispatch,
  target: StationMouseTarget,
): {
  onMouseDown: (event: MouseEvent) => void;
  onMouseScroll: (event: MouseEvent) => void;
} {
  return {
    onMouseDown: (event) => {
      event.stopPropagation();
      dispatch(target, event);
    },
    onMouseScroll: (event) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") {
        return;
      }
      event.stopPropagation();
      dispatch(target, event);
    },
  };
}

/** Track pointer: map cell y through core's inclusive ends, and swallow the
 * gesture so OpenTUI cannot start a drag selection on neighboring copy. */
export function stationScrollbarPointerProps(
  dispatch: StationMouseDispatch,
  input: {
    surface: "help" | "dashboard";
    contentLength: number;
    viewportLength: number;
    trackHeight: number;
    trackTop: () => number;
  },
): {
  onMouseDown: (event: MouseEvent) => void;
  onMouseDrag: (event: MouseEvent) => void;
  onMouseScroll: (event: MouseEvent) => void;
} {
  const emitOffset = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const trackHeight = Math.max(1, Math.floor(input.trackHeight));
    const trackIndex = Math.min(Math.max(0, event.y - input.trackTop()), trackHeight - 1);
    dispatch(
      {
        kind: "scrollbar",
        surface: input.surface,
        offset: scrollbarOffsetForTrackIndex({
          trackHeight,
          contentLength: input.contentLength,
          viewportLength: input.viewportLength,
          offset: 0,
          trackIndex,
        }),
      },
      event,
    );
  };
  return {
    onMouseDown: emitOffset,
    onMouseDrag: emitOffset,
    onMouseScroll: stationMouseProps(dispatch, {
      kind: "scrollbar",
      surface: input.surface,
      offset: 0,
    }).onMouseScroll,
  };
}
