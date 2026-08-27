// OpenTUI ScrollBar host for Help and the dashboard gutter. Core still windows
// rows; this only paints █/▀/▄ and reports drag/click offsets.
import { MouseEvent, type ColorInput } from "@opentui/core";
import { useStationMouse, stationMouseProps } from "./stationMouseContext.js";
import "./StationScrollBarRenderable.js";

const SCROLLBAR_ACTIVATE_EVENT = new MouseEvent(null, {
  type: "down",
  button: 0,
  x: 0,
  y: 0,
  modifiers: { shift: false, alt: false, ctrl: false },
});

export function StationScrollBarView({
  surface,
  contentLength,
  viewportLength,
  offset,
  trackBackground,
  thumbColor,
  height,
}: {
  surface: "help" | "dashboard";
  contentLength: number;
  viewportLength: number;
  offset: number;
  trackBackground: ColorInput;
  thumbColor: ColorInput;
  height: number;
}) {
  const dispatch = useStationMouse();
  const overflow = contentLength > viewportLength && viewportLength > 0;
  return (
    <stationScrollBar
      orientation="vertical"
      width={1}
      height={height}
      scrollSize={contentLength}
      viewportSize={Math.max(1, viewportLength)}
      scrollPosition={offset}
      visible={overflow}
      showArrows={false}
      trackOptions={{
        backgroundColor: trackBackground,
        foregroundColor: thumbColor,
      }}
      onPositionChange={(position) => {
        if (position === offset) {
          return;
        }
        dispatch({ kind: "scrollbar", surface, offset: position }, SCROLLBAR_ACTIVATE_EVENT);
      }}
      onMouseScroll={
        stationMouseProps(dispatch, { kind: "scrollbar", surface, offset }).onMouseScroll
      }
    />
  );
}
