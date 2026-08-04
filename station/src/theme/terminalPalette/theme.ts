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
  adjustLightnessForContrast,
  contrastRatio,
  mixOklch,
  relativeLuminance,
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
/** Fixed blend step so surface hierarchy resolution is byte-for-byte deterministic. */
const BLEND_STEP = 1 / 255;
/** Minimum WCAG contrast between adjacent layered surfaces so they stay distinguishable. */
const SURFACE_SEPARATION_RATIO = 1.12;

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
    hover: 0.08,
    keyboardFocus: 0.13,
    compactFocus: 0.17,
    selected: 0.19,
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
  if (observation === undefined || observation === null) {
    return nativeStationTheme;
  }
  return createTerminalPaletteTheme(observation);
}

/** Creates one complete embedded theme from a readable terminal palette observation. */
export function createTerminalPaletteTheme(
  observation: StationTerminalTheme,
): StationTheme {
  if (
    contrastRatio(observation.defaultForeground, observation.defaultBackground) <
    STATION_TEXT_CONTRAST_RATIO
  ) {
    // Whole-theme fallback prevents terminal surfaces from mixing with unrelated Station roles.
    return nativeStationTheme;
  }
  const foreground = observation.defaultForeground;
  const background = observation.defaultBackground;
  const defaultForeground = terminalDefaultColor("foreground", foreground);
  const defaultBackground = terminalDefaultColor("background", background);
  const recipe = TERMINAL_THEME_RECIPES[terminalPalettePolarity(observation)];

  const [hover, keyboardFocus, compactFocus, selected] = deriveInteractionSurfaces(
    background,
    foreground,
    recipe,
  );
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
      conditionSurface: defaultBackground,
      conditionSelected: compactFocus,
      conditionBackdrop: nativeStationTheme.filter.conditionBackdrop,
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

function deriveInteractionSurfaces(
  background: StationRgbColor,
  foreground: StationRgbColor,
  recipe: TerminalThemeRecipe,
): readonly [StationRgbColor, StationRgbColor, StationRgbColor, StationRgbColor] {
  const prior = [background];
  const surfaces = [recipe.hover, recipe.keyboardFocus, recipe.compactFocus, recipe.selected].map(
    (preferredAmount) => {
      const surface = surfaceWithHierarchy(background, foreground, preferredAmount, prior);
      prior.push(surface);
      return surface;
    },
  );
  return [surfaces[0], surfaces[1], surfaces[2], surfaces[3]];
}

/**
 * Picks the strongest blend toward the foreground that keeps text readable, then widens it
 * until the surface separates from every previously derived layered surface.
 */
function surfaceWithHierarchy(
  background: StationRgbColor,
  foreground: StationRgbColor,
  preferredAmount: number,
  priorSurfaces: readonly StationRgbColor[],
): StationRgbColor {
  const blendAt = (amount: number): StationRgbColor => mixOklch(background, foreground, amount);
  const textSafe = (amount: number): boolean =>
    contrastRatio(blendAt(amount), foreground) >= STATION_TEXT_CONTRAST_RATIO;
  const separated = (surface: StationRgbColor): boolean =>
    priorSurfaces.every((prior) => contrastRatio(surface, prior) >= SURFACE_SEPARATION_RATIO);

  const preferred = blendAt(preferredAmount);
  if (textSafe(preferredAmount) && separated(preferred)) {
    return preferred;
  }
  if (!textSafe(preferredAmount)) {
    // Preferred amount oversteps the text floor; walk down to the largest readable amount.
    let amount = preferredAmount;
    while (amount > 0 && !textSafe(amount)) {
      amount -= BLEND_STEP;
    }
    return blendAt(Math.max(0, amount));
  }
  // Text-safe but not separated yet; walk up toward the foreground, which always separates.
  let amount = preferredAmount;
  while (amount < 1) {
    amount += BLEND_STEP;
    const candidate = blendAt(amount);
    if (separated(candidate)) {
      return candidate;
    }
    if (!textSafe(amount)) {
      break;
    }
  }
  return preferred;
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
  return adjustLightnessForContrast(snapshot, foreground, backgrounds, target);
}

function inactiveAccent(
  background: StationRgbColor,
  active: StationSemanticColor,
): StationRgbColor {
  const activeSnapshot = stationColorSnapshot(active);
  return adjustLightnessForContrast(
    mixOklch(background, activeSnapshot, INACTIVE_ACCENT_BLEND),
    activeSnapshot,
    [background],
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
  return adjustLightnessForContrast(
    mixOklch(background, foreground, amount),
    foreground,
    backgrounds,
    target,
  );
}
