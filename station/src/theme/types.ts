/** The renderer placement whose ownership determines automatic appearance selection. */
export type StationAppearanceContext = "native-workspace" | "embedded-dashboard";

/** The current appearance policy; explicit Station/terminal choices land in #421. */
export type StationAppearancePreference = "auto";

/** A normalized six-digit sRGB color used as a renderer-neutral theme value. */
export type StationRgbColor = Readonly<{
  kind: "rgb";
  value: `#${string}`;
}>;

/** A terminal palette index with the observed RGB snapshot used by non-indexed consumers. */
export type StationIndexedColor = Readonly<{
  kind: "indexed";
  index: number;
  snapshot: StationRgbColor;
}>;

/** The enclosing terminal's default color and its stable observed RGB snapshot. */
export type StationTerminalDefaultColor<
  Channel extends "foreground" | "background" = "foreground" | "background",
> = Readonly<{
  kind: "terminal-default";
  channel: Channel;
  snapshot: StationRgbColor;
}>;

export type StationTerminalDefaultForegroundColor = StationTerminalDefaultColor<"foreground">;
export type StationTerminalDefaultBackgroundColor = StationTerminalDefaultColor<"background">;

/** An explicit sRGB color rendered with fractional alpha. */
export type StationAlphaColor = Readonly<{
  kind: "alpha";
  color: StationRgbColor;
  alpha: number;
}>;

/** Non-default semantic intent suitable for either foreground or background rendering. */
export type StationSemanticColor = StationRgbColor | StationIndexedColor | StationAlphaColor;

/** Renderer-neutral color intent preserved until a renderer adapter consumes it. */
export type StationColor = StationSemanticColor | StationTerminalDefaultColor;

/** Foreground intent whose terminal-default variant cannot carry background semantics. */
export type StationForegroundColor = StationSemanticColor | StationTerminalDefaultForegroundColor;

/** Color intent that always paints an opaque cell or terminal-owned default cell. */
export type StationOpaqueColor = Exclude<StationColor, StationAlphaColor>;

/** Opaque background intent whose terminal-default variant cannot carry foreground semantics. */
export type StationOpaqueBackgroundColor =
  | StationRgbColor
  | StationIndexedColor
  | StationTerminalDefaultBackgroundColor;

export type StationTerminalTheme = Readonly<{
  defaultForeground: StationRgbColor;
  defaultBackground: StationRgbColor;
  /** ANSI indices 0-15 in standard black through bright-white order. */
  ansi16: readonly [
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
  ];
}>;

export type StationPaneAccent = Readonly<{
  active: StationSemanticColor;
  inactive: StationSemanticColor;
}>;

type StationPaneAccentCycle = readonly [
  StationPaneAccent,
  StationPaneAccent,
  StationPaneAccent,
  StationPaneAccent,
];

/**
 * Complete semantic color contract shared by Station's native and embedded renderers.
 * Opaque background roles reject alpha and foreground-default intent by construction.
 */
export type StationTheme = Readonly<{
  surfaces: Readonly<{
    canvas: StationOpaqueBackgroundColor;
    panel: StationOpaqueBackgroundColor;
    prompt: StationOpaqueBackgroundColor;
    help: StationOpaqueBackgroundColor;
    sheet: StationOpaqueBackgroundColor;
    settings: StationOpaqueBackgroundColor;
    toast: StationOpaqueBackgroundColor;
  }>;
  text: Readonly<{
    primary: StationForegroundColor;
    muted: StationForegroundColor;
    inverse: StationForegroundColor;
    disabled: StationForegroundColor;
    menu: StationForegroundColor;
  }>;
  status: Readonly<{
    neutral: StationSemanticColor;
    danger: StationSemanticColor;
    warning: StationSemanticColor;
    success: StationSemanticColor;
    working: StationSemanticColor;
    info: StationSemanticColor;
    accent: StationSemanticColor;
  }>;
  action: Readonly<{
    primary: StationSemanticColor;
    success: StationSemanticColor;
    danger: StationSemanticColor;
    warning: StationSemanticColor;
  }>;
  interaction: Readonly<{
    hover: StationOpaqueBackgroundColor;
    keyboardFocus: StationOpaqueBackgroundColor;
    compactFocus: StationOpaqueBackgroundColor;
    border: StationSemanticColor;
    hairline: StationSemanticColor;
  }>;
  welcome: Readonly<{
    button: StationOpaqueBackgroundColor;
    buttonMuted: StationOpaqueBackgroundColor;
    buttonHover: StationOpaqueBackgroundColor;
    shimmer: StationSemanticColor;
    border: StationForegroundColor;
    borderActive: StationForegroundColor;
    muted: StationForegroundColor;
    wordmark: StationForegroundColor;
    shimmerPeak: StationSemanticColor;
  }>;
  contextMenu: Readonly<{
    surface: StationOpaqueBackgroundColor;
    selected: StationOpaqueBackgroundColor;
    border: StationSemanticColor;
  }>;
  island: Readonly<{
    background: StationOpaqueBackgroundColor;
    resting: StationSemanticColor;
    expanded: StationSemanticColor;
    attention: StationSemanticColor;
    actionable: StationSemanticColor;
  }>;
  pane: Readonly<{
    primary: StationPaneAccent;
    shells: StationPaneAccentCycle;
    selection: StationOpaqueBackgroundColor;
  }>;
  terminal: StationTerminalTheme;
}>;

const RGB_HEX_PATTERN = /^#[0-9a-f]{6}$/i;

export function rgbColor(value: `#${string}`): StationRgbColor {
  if (!RGB_HEX_PATTERN.test(value)) {
    throw new RangeError(`RGB color must use six-digit #rrggbb form, got ${value}`);
  }
  return { kind: "rgb", value: value.toLowerCase() as `#${string}` };
}

export function indexedColor(index: number, snapshot: StationRgbColor): StationIndexedColor {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new RangeError(`Indexed color must be an integer in the range 0..255, got ${index}`);
  }
  return { kind: "indexed", index, snapshot };
}

export function terminalDefaultColor<Channel extends "foreground" | "background">(
  channel: Channel,
  snapshot: StationRgbColor,
): StationTerminalDefaultColor<Channel> {
  return { kind: "terminal-default", channel, snapshot };
}

export function alphaColor(color: StationRgbColor, alpha: number): StationAlphaColor {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError(`Alpha must be finite and in the range 0..1, got ${alpha}`);
  }
  return { kind: "alpha", color, alpha };
}

/** Returns the deterministic RGB snapshot carried by any rendering intent. */
export function stationColorSnapshot(color: StationColor): StationRgbColor {
  switch (color.kind) {
    case "rgb":
      return color;
    case "indexed":
    case "terminal-default":
      return color.snapshot;
    case "alpha":
      return color.color;
  }
}

/** Returns the deterministic RGB snapshot value carried by any rendering intent. */
export function stationColorSnapshotValue(color: StationColor): `#${string}` {
  return stationColorSnapshot(color).value;
}
