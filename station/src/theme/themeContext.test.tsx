import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import { spanAtFrameCell } from "../terminal/testing/frameProbe.js";
import { embeddedStationTheme, nativeStationTheme } from "./builtInTheme.js";
import { toOpenTuiOpaqueColor } from "./openTuiColor.js";
import {
  EmbeddedStationThemeProvider,
  NativeStationThemeProvider,
  useStationTheme,
} from "./themeContext.js";
import type { StationTheme } from "./types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    teardown();
  }
});

function ThemeProbe({ onTheme }: { onTheme: (theme: StationTheme) => void }) {
  const theme = useStationTheme();
  onTheme(theme);
  return (
    <text bg={toOpenTuiOpaqueColor(theme.surfaces.canvas)}>
      probe
    </text>
  );
}

async function renderProvider(
  provider: (children: ReactNode) => ReactNode,
): Promise<{ selected: StationTheme; backgroundIntent: string }> {
  let selected: StationTheme | undefined;
  const setup = await testRender(
    provider(
      <ThemeProbe
        onTheme={(theme) => {
          selected = theme;
        }}
      />,
    ),
    { width: 10, height: 2 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  if (selected === undefined) {
    throw new Error("Theme probe did not render.");
  }
  const span = spanAtFrameCell(setup.captureSpans(), 0, 0);
  if (span?.bg === undefined) {
    throw new Error("Theme probe did not paint its canvas.");
  }
  return { selected, backgroundIntent: span.bg.intent };
}

describe("Station theme providers", () => {
  it("exposes the complete native theme and RGB canvas intent", async () => {
    const result = await renderProvider((children) => (
      <NativeStationThemeProvider>{children}</NativeStationThemeProvider>
    ));
    expect(result.selected).toBe(nativeStationTheme);
    expect(result.selected.terminal.ansi16).toHaveLength(16);
    expect(result.backgroundIntent).toBe("rgb");
  });

  it("exposes the complete embedded theme and terminal-default canvas intent", async () => {
    const result = await renderProvider((children) => (
      <EmbeddedStationThemeProvider>{children}</EmbeddedStationThemeProvider>
    ));
    expect(result.selected).toBe(embeddedStationTheme);
    expect(result.selected.pane.shells).toHaveLength(4);
    expect(result.backgroundIntent).toBe("default");
  });
});
