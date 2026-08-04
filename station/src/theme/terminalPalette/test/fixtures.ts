const nullableSpecialColors = {
  cursorColor: null,
  mouseForeground: null,
  mouseBackground: null,
  tekForeground: null,
  tekBackground: null,
  highlightBackground: null,
  highlightForeground: null,
} as const;

export const darkTerminalColors = {
  palette: [
    "#111827",
    "#b91c1c",
    "#047857",
    "#a16207",
    "#1d4ed8",
    "#7e22ce",
    "#0e7490",
    "#d1d5db",
    "#9ca3af",
    "#f87171",
    "#34d399",
    "#fbbf24",
    "#60a5fa",
    "#c084fc",
    "#22d3ee",
    "#f9fafb",
  ],
  defaultForeground: "#e5e7eb",
  defaultBackground: "#111827",
  ...nullableSpecialColors,
} as const;

export const lightTerminalColors = {
  palette: [
    "#111827",
    "#991b1b",
    "#065f46",
    "#854d0e",
    "#1e40af",
    "#6b21a8",
    "#155e75",
    "#374151",
    "#4b5563",
    "#b91c1c",
    "#047857",
    "#a16207",
    "#1d4ed8",
    "#7e22ce",
    "#0e7490",
    "#1f2937",
  ],
  defaultForeground: "#1f2937",
  defaultBackground: "#f9fafb",
  cursorColor: "#1f2937",
  mouseForeground: null,
  mouseBackground: null,
  tekForeground: null,
  tekBackground: null,
  highlightBackground: "#dbeafe",
  highlightForeground: "#1e3a8a",
} as const;

export const veryDarkTerminalColors = {
  ...darkTerminalColors,
  defaultForeground: "#ffffff",
  defaultBackground: "#000000",
} as const;

export const veryLightTerminalColors = {
  ...lightTerminalColors,
  defaultForeground: "#000000",
  defaultBackground: "#ffffff",
} as const;

export const nearWhiteTerminalColors = {
  ...lightTerminalColors,
  defaultForeground: "#111827",
  defaultBackground: "#fefefe",
} as const;

export const weakAnsiLightTerminalColors = {
  ...lightTerminalColors,
  palette: [
    "#f1f2f3",
    "#f2efee",
    "#eef2ee",
    "#f2f1e9",
    "#eef1f4",
    "#f1eef3",
    "#edf2f2",
    "#f3f3f3",
    "#e9eaec",
    "#f0c4c4",
    "#c9e8c9",
    "#ebe6b4",
    "#c4d9f2",
    "#e0c8ee",
    "#bae4ea",
    "#ebebeb",
  ],
} as const;

export const weakAnsiTerminalColors = {
  ...darkTerminalColors,
  palette: [
    "#171f2b",
    "#18202c",
    "#19212d",
    "#1a222e",
    "#1b232f",
    "#1c2430",
    "#1d2531",
    "#1e2632",
    "#1f2733",
    "#202834",
    "#212935",
    "#222a36",
    "#232b37",
    "#242c38",
    "#252d39",
    "#262e3a",
  ],
} as const;

export const lowContrastTerminalColors = {
  ...darkTerminalColors,
  defaultForeground: "#777777",
  defaultBackground: "#7a7a7a",
} as const;

export const malformedTerminalColors = {
  ...darkTerminalColors,
  defaultForeground: "#abc",
} as const;

export const unsupportedTerminalColors = {
  palette: Array.from({ length: 16 }, () => null),
  defaultForeground: null,
  defaultBackground: null,
  ...nullableSpecialColors,
} as const;

export const saturatedLightTerminalColors = {
  ...lightTerminalColors,
  palette: [
    "#111827",
    "#991b1b",
    "#065f46",
    "#854d0e",
    "#1e40af",
    "#6b21a8",
    "#155e75",
    "#374151",
    "#4b5563",
    "#ff5f5f",
    "#7bff7b",
    "#fff95b",
    "#5f8bff",
    "#ff7bff",
    "#5fffff",
    "#1f2937",
  ],
} as const;

export const saturatedDarkTerminalColors = {
  ...darkTerminalColors,
  palette: [
    "#111827",
    "#7a0000",
    "#004d00",
    "#7a5f00",
    "#001d7a",
    "#5c007a",
    "#004d5c",
    "#d1d5db",
    "#9ca3af",
    "#ff0000",
    "#00d500",
    "#d5d500",
    "#0055ff",
    "#d500ff",
    "#00e5e5",
    "#f9fafb",
  ],
} as const;

export const grayTerminalColors = {
  ...darkTerminalColors,
  palette: Array.from({ length: 16 }, (_, index) => {
    const channel = 0x30 + index * 4;
    const value = channel.toString(16).padStart(2, "0");
    return `#${value}${value}${value}`;
  }),
} as const;
