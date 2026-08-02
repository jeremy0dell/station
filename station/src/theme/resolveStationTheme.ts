import { nativeStationTheme } from "./builtInTheme.js";
import type { StationTerminalPaletteObservation } from "./terminalPaletteObservation.js";
import {
  indexedColor,
  rgbColor,
  stationColorSnapshot,
  terminalDefaultColor,
  type StationAppearanceContext,
  type StationAppearancePreference,
  type StationRgbColor,
  type StationSemanticColor,
  type StationTheme,
} from "./types.js";

/** WCAG contrast target for ordinary text and inverse action text. */
export const STATION_TEXT_CONTRAST_RATIO = 4.5;
/** WCAG contrast target for borders, disabled treatment, and interaction boundaries. */
export const STATION_BOUNDARY_CONTRAST_RATIO = 3;

type ResolveStationThemeInput = Readonly<{
  context: StationAppearanceContext;
  preference: StationAppearancePreference;
  observation?: StationTerminalPaletteObservation | null;
}>;

type RgbTriplet = readonly [number, number, number];

/**
 * Resolves one complete provider-neutral Station theme for the renderer composition.
 * Native auto remains Station-owned; embedded auto adapts only from a complete, valid palette.
 */
export function resolveStationTheme(input: ResolveStationThemeInput): StationTheme {
  if (input.context === "native-workspace") {
    return nativeStationTheme;
  }

  const observation = input.observation;
  if (
    observation === undefined ||
    observation === null ||
    contrastRatio(observation.defaultForeground, observation.defaultBackground) <
      STATION_TEXT_CONTRAST_RATIO
  ) {
    // Whole-theme fallback prevents terminal surfaces from being mixed with unrelated Station roles.
    return nativeStationTheme;
  }

  return resolveEmbeddedTerminalTheme(observation);
}

function resolveEmbeddedTerminalTheme(
  observation: StationTerminalPaletteObservation,
): StationTheme {
  const foreground = observation.defaultForeground;
  const background = observation.defaultBackground;
  const defaultForeground = terminalDefaultColor("foreground", foreground);
  const defaultBackground = terminalDefaultColor("background", background);
  const backgroundIsDark = relativeLuminance(background) < relativeLuminance(foreground);

  const textMuted = foregroundBlend(
    background,
    foreground,
    backgroundIsDark ? 0.7 : 0.66,
    STATION_TEXT_CONTRAST_RATIO,
  );
  const textDisabled = foregroundBlend(
    background,
    foreground,
    backgroundIsDark ? 0.5 : 0.46,
    STATION_BOUNDARY_CONTRAST_RATIO,
  );
  const border = foregroundBlend(
    background,
    foreground,
    backgroundIsDark ? 0.48 : 0.44,
    STATION_BOUNDARY_CONTRAST_RATIO,
  );
  const hairline = foregroundBlend(
    background,
    foreground,
    backgroundIsDark ? 0.42 : 0.38,
    STATION_BOUNDARY_CONTRAST_RATIO,
  );

  const hover = readableSurfaceBlend(background, foreground, backgroundIsDark ? 0.08 : 0.06);
  const keyboardFocus = readableSurfaceBlend(
    background,
    foreground,
    backgroundIsDark ? 0.13 : 0.1,
  );
  const compactFocus = readableSurfaceBlend(
    background,
    foreground,
    backgroundIsDark ? 0.18 : 0.14,
  );
  const selected = readableSurfaceBlend(
    background,
    foreground,
    backgroundIsDark ? 0.2 : 0.16,
  );

  const ansiText = (index: number): StationSemanticColor =>
    ansiColorWithContrast(
      observation,
      index,
      background,
      foreground,
      STATION_TEXT_CONTRAST_RATIO,
    );
  const ansiBoundary = (index: number): StationSemanticColor =>
    ansiColorWithContrast(
      observation,
      index,
      background,
      foreground,
      STATION_BOUNDARY_CONTRAST_RATIO,
    );

  const neutral = ansiText(8);
  const danger = ansiText(9);
  const warning = ansiText(11);
  const success = ansiText(10);
  const working = ansiText(12);
  const info = ansiText(14);
  const accent = ansiText(13);
  const actionPrimary = ansiText(14);
  const actionSuccess = ansiText(10);
  const actionDanger = ansiText(9);
  const actionWarning = ansiText(11);

  const primaryPane = ansiBoundary(12);
  const shellGreen = ansiBoundary(10);
  const shellPurple = ansiBoundary(13);
  const shellYellow = ansiBoundary(11);
  const shellCyan = ansiBoundary(14);

  return {
    surfaces: {
      canvas: defaultBackground,
      panel: defaultBackground,
      prompt: defaultBackground,
      help: defaultBackground,
      sheet: defaultBackground,
      settings: defaultBackground,
      toast: defaultBackground,
    },
    text: {
      primary: defaultForeground,
      muted: textMuted,
      inverse: background,
      disabled: textDisabled,
      menu: defaultForeground,
    },
    status: {
      neutral,
      danger,
      warning,
      success,
      working,
      info,
      accent,
    },
    action: {
      primary: actionPrimary,
      success: actionSuccess,
      danger: actionDanger,
      warning: actionWarning,
    },
    interaction: {
      hover,
      keyboardFocus,
      compactFocus,
      border,
      hairline,
    },
    welcome: {
      button: keyboardFocus,
      buttonMuted: background,
      buttonHover: compactFocus,
      shimmer: foregroundBlend(background, foreground, 0.5, STATION_BOUNDARY_CONTRAST_RATIO),
      border,
      borderActive: working,
      muted: textMuted,
      wordmark: defaultForeground,
      shimmerPeak: foreground,
    },
    contextMenu: {
      surface: defaultBackground,
      selected,
      border,
    },
    island: {
      background: defaultBackground,
      resting: success,
      expanded: working,
      attention: danger,
      actionable: accent,
    },
    pane: {
      primary: {
        active: primaryPane,
        inactive: inactiveAccent(background, primaryPane),
      },
      shells: [
        { active: shellGreen, inactive: inactiveAccent(background, shellGreen) },
        { active: shellPurple, inactive: inactiveAccent(background, shellPurple) },
        { active: shellYellow, inactive: inactiveAccent(background, shellYellow) },
        { active: shellCyan, inactive: inactiveAccent(background, shellCyan) },
      ],
      selection: selected,
    },
    terminal: observation,
  };
}

function ansiColorWithContrast(
  observation: StationTerminalPaletteObservation,
  index: number,
  background: StationRgbColor,
  foreground: StationRgbColor,
  target: number,
): StationSemanticColor {
  const snapshot = observation.ansi16[index];
  if (snapshot === undefined) {
    throw new RangeError(`ANSI palette index ${index} is unavailable.`);
  }
  if (contrastRatio(snapshot, background) >= target) {
    return indexedColor(index, snapshot);
  }
  return blendUntilContrast(snapshot, foreground, background, target);
}

function inactiveAccent(
  background: StationRgbColor,
  active: StationSemanticColor,
): StationRgbColor {
  const activeSnapshot = stationColorSnapshot(active);
  return blendUntilContrast(
    mixRgb(background, activeSnapshot, 0.55),
    activeSnapshot,
    background,
    STATION_BOUNDARY_CONTRAST_RATIO,
  );
}

function foregroundBlend(
  background: StationRgbColor,
  foreground: StationRgbColor,
  amount: number,
  target: number,
): StationRgbColor {
  return blendUntilContrast(
    mixRgb(background, foreground, amount),
    foreground,
    background,
    target,
  );
}

function readableSurfaceBlend(
  background: StationRgbColor,
  foreground: StationRgbColor,
  preferredAmount: number,
): StationRgbColor {
  for (let step = Math.round(preferredAmount * 255); step >= 0; step -= 1) {
    const candidate = mixRgb(background, foreground, step / 255);
    if (contrastRatio(candidate, foreground) >= STATION_TEXT_CONTRAST_RATIO) {
      return candidate;
    }
  }
  return background;
}

function blendUntilContrast(
  start: StationRgbColor,
  toward: StationRgbColor,
  background: StationRgbColor,
  target: number,
): StationRgbColor {
  if (contrastRatio(start, background) >= target) {
    return start;
  }
  for (let step = 1; step <= 255; step += 1) {
    const candidate = mixRgb(start, toward, step / 255);
    if (contrastRatio(candidate, background) >= target) {
      return candidate;
    }
  }
  return toward;
}

function mixRgb(from: StationRgbColor, to: StationRgbColor, amount: number): StationRgbColor {
  const fromRgb = rgbTriplet(from);
  const toRgb = rgbTriplet(to);
  const clamped = Math.max(0, Math.min(1, amount));
  return rgbFromTriplet([
    Math.round(fromRgb[0] + (toRgb[0] - fromRgb[0]) * clamped),
    Math.round(fromRgb[1] + (toRgb[1] - fromRgb[1]) * clamped),
    Math.round(fromRgb[2] + (toRgb[2] - fromRgb[2]) * clamped),
  ]);
}

function contrastRatio(first: StationRgbColor, second: StationRgbColor): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: StationRgbColor): number {
  const [red, green, blue] = rgbTriplet(color).map((component) => {
    const channel = component / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function rgbTriplet(color: StationRgbColor): RgbTriplet {
  return [
    Number.parseInt(color.value.slice(1, 3), 16),
    Number.parseInt(color.value.slice(3, 5), 16),
    Number.parseInt(color.value.slice(5, 7), 16),
  ];
}

function rgbFromTriplet([red, green, blue]: RgbTriplet): StationRgbColor {
  const value = [red, green, blue]
    .map((component) => component.toString(16).padStart(2, "0"))
    .join("");
  return rgbColor(`#${value}`);
}
