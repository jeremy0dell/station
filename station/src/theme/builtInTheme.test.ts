import { describe, expect, it } from "bun:test";
import { embeddedStationTheme, nativeStationTheme } from "./builtInTheme.js";
import type { StationTheme } from "./types.js";

const rgb = (value: `#${string}`) => ({ kind: "rgb" as const, value });
const defaultBackground = (value: `#${string}`) => ({
  kind: "terminal-default" as const,
  channel: "background" as const,
  snapshot: rgb(value),
});

const terminal = {
  defaultForeground: rgb("#d4d4d8"),
  defaultBackground: rgb("#101316"),
  ansi16: [
    rgb("#000000"),
    rgb("#cd3131"),
    rgb("#0dbc79"),
    rgb("#e5e510"),
    rgb("#2472c8"),
    rgb("#bc3fbc"),
    rgb("#11a8cd"),
    rgb("#e5e5e5"),
    rgb("#666666"),
    rgb("#f14c4c"),
    rgb("#23d18b"),
    rgb("#f5f543"),
    rgb("#3b8eea"),
    rgb("#d670d6"),
    rgb("#29b8db"),
    rgb("#ffffff"),
  ],
} as const;

const sharedRoles = {
  text: {
    primary: rgb("#e4e4e7"),
    muted: rgb("#9ca3af"),
    inverse: rgb("#101316"),
    disabled: rgb("#7a828c"),
    menu: rgb("#f4f4f5"),
  },
  status: {
    neutral: rgb("#9ca3af"),
    danger: rgb("#f87171"),
    warning: rgb("#fbbf24"),
    success: rgb("#4ade80"),
    working: rgb("#60a5fa"),
    info: rgb("#60a5fa"),
    accent: rgb("#d2a8ff"),
  },
  action: {
    primary: rgb("#22d3ee"),
    success: rgb("#4ade80"),
    danger: rgb("#f87171"),
    warning: rgb("#fbbf24"),
  },
  interaction: {
    hover: rgb("#1f242b"),
    keyboardFocus: rgb("#15222e"),
    compactFocus: rgb("#1b3448"),
    border: rgb("#9ca3af"),
    hairline: rgb("#20252c"),
  },
  welcome: {
    button: rgb("#1f2937"),
    buttonMuted: rgb("#101316"),
    buttonHover: rgb("#263142"),
    shimmer: rgb("#4a6a8c"),
    border: rgb("#3f4750"),
    borderActive: rgb("#60a5fa"),
    muted: rgb("#a1a1aa"),
    wordmark: rgb("#f4f4f5"),
    shimmerPeak: rgb("#ffffff"),
  },
  contextMenu: {
    surface: rgb("#15191e"),
    selected: rgb("#2f3842"),
    border: rgb("#5b6470"),
  },
  island: {
    background: rgb("#101316"),
    resting: rgb("#4ade80"),
    expanded: rgb("#60a5fa"),
    attention: rgb("#f87171"),
    actionable: rgb("#d2a8ff"),
  },
  pane: {
    primary: { active: rgb("#60a5fa"), inactive: rgb("#1d4ed8") },
    shells: [
      { active: rgb("#34d399"), inactive: rgb("#14532d") },
      { active: rgb("#c084fc"), inactive: rgb("#581c87") },
      { active: rgb("#fbbf24"), inactive: rgb("#713f12") },
      { active: rgb("#22d3ee"), inactive: rgb("#164e63") },
    ],
    selection: rgb("#264f78"),
  },
  terminal,
} as const;

const expectedNativeTheme = {
  ...sharedRoles,
  surfaces: {
    canvas: rgb("#101316"),
    panel: rgb("#101316"),
    prompt: rgb("#101316"),
    help: rgb("#000000"),
    sheet: rgb("#101316"),
    settings: rgb("#101316"),
    toast: rgb("#101316"),
  },
} as const satisfies StationTheme;

const expectedEmbeddedTheme = {
  ...sharedRoles,
  surfaces: {
    canvas: defaultBackground("#101316"),
    panel: defaultBackground("#101316"),
    prompt: defaultBackground("#101316"),
    help: defaultBackground("#101316"),
    sheet: defaultBackground("#101316"),
    settings: defaultBackground("#101316"),
    toast: defaultBackground("#101316"),
  },
  contextMenu: {
    ...sharedRoles.contextMenu,
    surface: defaultBackground("#15191e"),
  },
  island: {
    ...sharedRoles.island,
    background: defaultBackground("#101316"),
  },
} as const satisfies StationTheme;

describe("built-in Station themes", () => {
  it("preserves every native role and RGB value", () => {
    expect(nativeStationTheme).toEqual(expectedNativeTheme);
  });

  it("preserves every embedded role, intent, channel, and snapshot", () => {
    expect(embeddedStationTheme).toEqual(expectedEmbeddedTheme);
  });
});
