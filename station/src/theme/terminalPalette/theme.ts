import { nativeStationTheme } from "../builtInTheme.js";
import {
  indexedColor,
  stationColorSnapshot,
  terminalDefaultColor,
  type StationRgbColor,
  type StationSemanticColor,
  type StationTerminalTheme,
  type StationTheme,
} from "../types.js";
import {
  blendUntilContrast,
  blendUntilContrasts,
  contrastRatio,
  mixRgb,
  relativeLuminance,
  SRGB_CHANNEL_MAX,
  STATION_BOUNDARY_CONTRAST_RATIO,
  STATION_TEXT_CONTRAST_RATIO,
} from "./contrast.js";

const ANSI_INDEX = {
  brightBlack: 8,
  brightRed: 9,
  brightGreen: 10,
  brightYellow: 11,
  brightBlue: 12,
  brightMagenta: 13,
  brightCyan: 14,
} as const;

const INACTIVE_ACCENT_BLEND = 0.55;
const WELCOME_SHIMMER_BLEND = 0.5;

type TerminalPalettePolarity = "dark" | "light";
type TerminalThemeRecipe = Readonly<{
  textMuted: number;
  textDisabled: number;
  border: number;
  hairline: number;
  hover: number;
  keyboardFocus: number;
  compactFocus: number;
  selected: number;
}>;

const TERMINAL_THEME_RECIPES = {
  dark: {
    textMuted: 0.7,
    textDisabled: 0.5,
    border: 0.48,
    hairline: 0.42,
    hover: 0.08,
    keyboardFocus: 0.13,
    compactFocus: 0.18,
    selected: 0.2,
  },
  light: {
    textMuted: 0.66,
    textDisabled: 0.46,
    border: 0.44,
    hairline: 0.38,
    hover: 0.06,
    keyboardFocus: 0.1,
    compactFocus: 0.14,
    selected: 0.16,
  },
} as const satisfies Record<TerminalPalettePolarity, TerminalThemeRecipe>;

/**
 * Classifies the observed defaults by luminance; OpenTUI's theme-mode label is not color authority.
 */
export function terminalPalettePolarity(
  observation: StationTerminalTheme,
): TerminalPalettePolarity {
  return relativeLuminance(observation.defaultBackground) <
    relativeLuminance(observation.defaultForeground)
    ? "dark"
    : "light";
}

/** Resolves complete embedded palette evidence or the whole built-in fallback theme. */
export function resolveEmbeddedStationTheme(
  observation: StationTerminalTheme | null | undefined,
): StationTheme {
  if (
    observation === undefined ||
    observation === null ||
    contrastRatio(observation.defaultForeground, observation.defaultBackground) <
      STATION_TEXT_CONTRAST_RATIO
  ) {
    // Whole-theme fallback prevents terminal surfaces from mixing with unrelated Station roles.
    return nativeStationTheme;
  }
  return createTerminalPaletteTheme(observation);
}

/** Creates one complete embedded theme from a validated, readable terminal palette. */
export function createTerminalPaletteTheme(
  observation: StationTerminalTheme,
): StationTheme {
  const foreground = observation.defaultForeground;
  const background = observation.defaultBackground;
  const defaultForeground = terminalDefaultColor("foreground", foreground);
  const defaultBackground = terminalDefaultColor("background", background);
  const recipe = TERMINAL_THEME_RECIPES[terminalPalettePolarity(observation)];

  const hover = readableSurfaceBlend(background, foreground, recipe.hover);
  const keyboardFocus = readableSurfaceBlend(background, foreground, recipe.keyboardFocus);
  const compactFocus = readableSurfaceBlend(background, foreground, recipe.compactFocus);
  const selected = readableSurfaceBlend(background, foreground, recipe.selected);
  const interactionSurfaces = [background, hover, keyboardFocus, compactFocus] as const;

  const textMuted = foregroundBlend(
    interactionSurfaces,
    foreground,
    recipe.textMuted,
    STATION_TEXT_CONTRAST_RATIO,
  );
  const textDisabled = foregroundBlend(
    interactionSurfaces,
    foreground,
    recipe.textDisabled,
    STATION_BOUNDARY_CONTRAST_RATIO,
  );
  const border = foregroundBlend(
    [background],
    foreground,
    recipe.border,
    STATION_BOUNDARY_CONTRAST_RATIO,
  );
  const hairline = foregroundBlend(
    [background],
    foreground,
    recipe.hairline,
    STATION_BOUNDARY_CONTRAST_RATIO,
  );

  const ansiText = (index: number): StationSemanticColor =>
    ansiColorWithContrast(
      observation,
      index,
      interactionSurfaces,
      foreground,
      STATION_TEXT_CONTRAST_RATIO,
    );
  const ansiBoundary = (index: number): StationSemanticColor =>
    ansiColorWithContrast(
      observation,
      index,
      [background],
      foreground,
      STATION_BOUNDARY_CONTRAST_RATIO,
    );

  const neutral = ansiText(ANSI_INDEX.brightBlack);
  const danger = ansiText(ANSI_INDEX.brightRed);
  const warning = ansiText(ANSI_INDEX.brightYellow);
  const success = ansiText(ANSI_INDEX.brightGreen);
  const working = ansiText(ANSI_INDEX.brightBlue);
  const info = ansiText(ANSI_INDEX.brightCyan);
  const accent = ansiText(ANSI_INDEX.brightMagenta);
  const actionPrimary = ansiText(ANSI_INDEX.brightCyan);
  const actionSuccess = ansiText(ANSI_INDEX.brightGreen);
  const actionDanger = ansiText(ANSI_INDEX.brightRed);
  const actionWarning = ansiText(ANSI_INDEX.brightYellow);

  const primaryPane = ansiBoundary(ANSI_INDEX.brightBlue);
  const shellGreen = ansiBoundary(ANSI_INDEX.brightGreen);
  const shellPurple = ansiBoundary(ANSI_INDEX.brightMagenta);
  const shellYellow = ansiBoundary(ANSI_INDEX.brightYellow);
  const shellCyan = ansiBoundary(ANSI_INDEX.brightCyan);

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
    filter: {
      editorRail: actionPrimary,
      editorSurface: keyboardFocus,
      appliedSurface: hover,
      matchForeground: defaultForeground,
      matchBackground: selected,
      zeroMatch: actionWarning,
    },
    welcome: {
      button: keyboardFocus,
      buttonMuted: background,
      buttonHover: compactFocus,
      shimmer: foregroundBlend(
        [background],
        foreground,
        WELCOME_SHIMMER_BLEND,
        STATION_BOUNDARY_CONTRAST_RATIO,
      ),
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
  observation: StationTerminalTheme,
  index: number,
  backgrounds: readonly StationRgbColor[],
  foreground: StationRgbColor,
  target: number,
): StationSemanticColor {
  const snapshot = observation.ansi16[index];
  if (snapshot === undefined) {
    throw new RangeError(`ANSI palette index ${index} is unavailable.`);
  }
  if (backgrounds.every((background) => contrastRatio(snapshot, background) >= target)) {
    return indexedColor(index, snapshot);
  }
  return blendUntilContrasts(snapshot, foreground, backgrounds, target);
}

function inactiveAccent(
  background: StationRgbColor,
  active: StationSemanticColor,
): StationRgbColor {
  const activeSnapshot = stationColorSnapshot(active);
  return blendUntilContrast(
    mixRgb(background, activeSnapshot, INACTIVE_ACCENT_BLEND),
    activeSnapshot,
    background,
    STATION_BOUNDARY_CONTRAST_RATIO,
  );
}

function foregroundBlend(
  backgrounds: readonly StationRgbColor[],
  foreground: StationRgbColor,
  amount: number,
  target: number,
): StationRgbColor {
  const background = backgrounds[0];
  if (background === undefined) {
    throw new RangeError("Foreground blends require at least one background.");
  }
  return blendUntilContrasts(
    mixRgb(background, foreground, amount),
    foreground,
    backgrounds,
    target,
  );
}

function readableSurfaceBlend(
  background: StationRgbColor,
  foreground: StationRgbColor,
  preferredAmount: number,
): StationRgbColor {
  for (
    let step = Math.round(preferredAmount * SRGB_CHANNEL_MAX);
    step >= 0;
    step -= 1
  ) {
    const candidate = mixRgb(background, foreground, step / SRGB_CHANNEL_MAX);
    if (contrastRatio(candidate, foreground) >= STATION_TEXT_CONTRAST_RATIO) {
      return candidate;
    }
  }
  return background;
}
