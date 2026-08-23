import { type Renderable, Yoga } from "@opentui/core";

/** Reads OpenTUI's terminal-cell insets at the renderer layout boundary. */
export function measuredVerticalInsets(renderable: Renderable): number {
  const layout = renderable.getLayoutNode();
  return (
    layout.getComputedBorder(Yoga.Edge.Top) +
    layout.getComputedPadding(Yoga.Edge.Top) +
    layout.getComputedPadding(Yoga.Edge.Bottom) +
    layout.getComputedBorder(Yoga.Edge.Bottom)
  );
}
