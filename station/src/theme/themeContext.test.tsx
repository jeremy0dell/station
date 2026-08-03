import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import { spanAtFrameCell } from "../terminal/testing/frameProbe.js";
import { nativeStationTheme } from "./builtInTheme.js";
import { toOpenTuiOpaqueColor } from "./openTuiColor.js";
import { parseStationTerminalPaletteObservation } from "./terminalPalette/observation.js";
import { darkTerminalColors, lightTerminalColors } from "./terminalPalette/test/fixtures.js";
import { createTerminalPaletteTheme } from "./terminalPalette/theme.js";
import {
  StationThemeProvider,
  useStationTheme,
  useStationThemeSource,
  type StationThemeSource,
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

class MutableThemeSource implements StationThemeSource {
  private snapshot: StationTheme;
  private readonly listeners = new Set<() => void>();

  constructor(snapshot: StationTheme) {
    this.snapshot = snapshot;
  }

  readonly getSnapshot = (): StationTheme => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(theme: StationTheme): void {
    this.snapshot = theme;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function ThemeSourceRoot({
  source,
  onTheme,
}: {
  source: StationThemeSource;
  onTheme: (theme: StationTheme) => void;
}) {
  const theme = useStationThemeSource(source);
  return (
    <StationThemeProvider theme={theme}>
      <ThemeProbe onTheme={onTheme} />
    </StationThemeProvider>
  );
}

function terminalTheme(value: unknown): StationTheme {
  const observation = parseStationTerminalPaletteObservation(value);
  if (observation === null) {
    throw new Error("Expected complete terminal fixture.");
  }
  return createTerminalPaletteTheme(observation);
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

  it("rerenders an external theme-source update through the same provider", async () => {
    const darkTheme = terminalTheme(darkTerminalColors);
    const lightTheme = terminalTheme(lightTerminalColors);
    const source = new MutableThemeSource(darkTheme);
    const selected: StationTheme[] = [];
    const setup = await testRender(
      <ThemeSourceRoot source={source} onTheme={(theme) => selected.push(theme)} />,
      { width: 10, height: 2 },
    );
    teardowns.push(() => setup.renderer.destroy());
    await setup.renderOnce();
    expect(selected.at(-1)).toBe(darkTheme);

    await act(async () => {
      source.set(lightTheme);
      await Promise.resolve();
    });
    await setup.flush();

    expect(selected.at(-1)).toBe(lightTheme);
    expect(selected.at(-1)?.pane.shells).toHaveLength(4);
    expect(spanAtFrameCell(setup.captureSpans(), 0, 0)?.bg.intent).toBe("default");
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
