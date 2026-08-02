import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import { spanAtFrameCell } from "../terminal/testing/frameProbe.js";
import { embeddedStationTheme, nativeStationTheme } from "./builtInTheme.js";
import { toOpenTuiOpaqueColor } from "./openTuiColor.js";
import { StationThemeProvider, useStationTheme } from "./themeContext.js";
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
  return <text bg={toOpenTuiOpaqueColor(theme.surfaces.canvas)}>probe</text>;
}

async function renderProvider(
  theme: StationTheme,
): Promise<{ selected: StationTheme; backgroundIntent: string }> {
  let selected: StationTheme | undefined;
  const setup = await testRender(
    <StationThemeProvider theme={theme}>
      <ThemeProbe
        onTheme={(selectedTheme) => {
          selected = selectedTheme;
        }}
      />
    </StationThemeProvider>,
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

function MissingProviderProbe(): ReactNode {
  useStationTheme();
  return null;
}

describe("Station theme provider", () => {
  it("exposes the complete native theme and RGB canvas intent", async () => {
    const result = await renderProvider(nativeStationTheme);
    expect(result.selected).toBe(nativeStationTheme);
    expect(result.selected.terminal.ansi16).toHaveLength(16);
    expect(result.backgroundIntent).toBe("rgb");
  });

  it("exposes the complete embedded theme and terminal-default canvas intent", async () => {
    const result = await renderProvider(embeddedStationTheme);
    expect(result.selected).toBe(embeddedStationTheme);
    expect(result.selected.pane.shells).toHaveLength(4);
    expect(result.backgroundIntent).toBe("default");
  });

  it("fails when a renderer leaf is mounted without an explicit provider", async () => {
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const setup = await testRender(<MissingProviderProbe />, { width: 80, height: 12 });
      teardowns.push(() => setup.renderer.destroy());
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain(
        "useStationTheme must be used within StationThemeProvider",
      );
    } finally {
      console.error = originalConsoleError;
    }
  });
});
