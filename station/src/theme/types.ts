/** A six-digit sRGB color used as a renderer-neutral theme value. */
export type StationRgbColor = Readonly<{
  kind: "rgb";
  value: `#${string}`;
}>;

/** A terminal palette index whose RGB value is resolved by the renderer. */
export type StationIndexedColor = Readonly<{
  kind: "indexed";
  index: number;
}>;

/** The enclosing terminal's default color, with a stable RGB snapshot for unsupported renderers. */
export type StationTerminalDefaultColor = Readonly<{
  kind: "terminal-default";
  channel: "foreground" | "background";
  fallback: StationRgbColor;
}>;

/** An explicit sRGB color rendered with fractional alpha. */
export type StationAlphaColor = Readonly<{
  kind: "alpha";
  color: StationRgbColor;
  alpha: number;
}>;

/** Renderer-neutral color intent preserved until a renderer adapter consumes it. */
export type StationColor =
  | StationRgbColor
  | StationIndexedColor
  | StationTerminalDefaultColor
  | StationAlphaColor;

/** Color intent that always paints an opaque cell or terminal-owned default cell. */
export type StationOpaqueColor = Exclude<StationColor, StationAlphaColor>;

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
  active: StationRgbColor;
  inactive: StationRgbColor;
}>;

/**
 * Complete semantic color contract shared by Station's native and embedded renderers.
 * Surface roles are opaque by construction; components select roles rather than palette values.
 */
export type StationTheme = Readonly<{
  surfaces: Readonly<{
    canvas: StationOpaqueColor;
    panel: StationOpaqueColor;
    frozen: StationOpaqueColor;
    prompt: StationOpaqueColor;
    help: StationOpaqueColor;
    sheet: StationOpaqueColor;
    settings: StationOpaqueColor;
    toast: StationOpaqueColor;
    overlay: StationOpaqueColor;
  }>;
  text: Readonly<{
    primary: StationRgbColor;
    muted: StationRgbColor;
    inverse: StationRgbColor;
    disabled: StationRgbColor;
    menu: StationRgbColor;
  }>;
  status: Readonly<{
    neutral: StationRgbColor;
    danger: StationRgbColor;
    warning: StationRgbColor;
    success: StationRgbColor;
    working: StationRgbColor;
    info: StationRgbColor;
    accent: StationRgbColor;
  }>;
  action: Readonly<{
    primary: StationRgbColor;
    success: StationRgbColor;
    danger: StationRgbColor;
    warning: StationRgbColor;
  }>;
  interaction: Readonly<{
    hover: StationRgbColor;
    keyboardFocus: StationRgbColor;
    compactFocus: StationRgbColor;
    border: StationRgbColor;
    hairline: StationRgbColor;
    overlay: StationOpaqueColor;
  }>;
  welcome: Readonly<{
    button: StationRgbColor;
    buttonMuted: StationRgbColor;
    buttonHover: StationRgbColor;
    shimmer: StationRgbColor;
    border: StationRgbColor;
    borderActive: StationRgbColor;
    muted: StationRgbColor;
    wordmark: StationRgbColor;
    shimmerPeak: StationRgbColor;
  }>;
  contextMenu: Readonly<{
    surface: StationOpaqueColor;
    selected: StationRgbColor;
    border: StationRgbColor;
  }>;
  island: Readonly<{
    background: StationOpaqueColor;
    resting: StationRgbColor;
    expanded: StationRgbColor;
    attention: StationRgbColor;
    actionable: StationRgbColor;
  }>;
  pane: Readonly<{
    primary: StationPaneAccent;
    shells: readonly StationPaneAccent[];
    selection: StationRgbColor;
  }>;
  terminal: StationTerminalTheme;
}>;

export function rgbColor(value: `#${string}`): StationRgbColor {
  return { kind: "rgb", value };
}

export function indexedColor(index: number): StationIndexedColor {
  return { kind: "indexed", index };
}

export function terminalDefaultColor(
  channel: StationTerminalDefaultColor["channel"],
  fallback: StationRgbColor,
): StationTerminalDefaultColor {
  return { kind: "terminal-default", channel, fallback };
}

export function alphaColor(color: StationRgbColor, alpha: number): StationAlphaColor {
  return { kind: "alpha", color, alpha };
}
