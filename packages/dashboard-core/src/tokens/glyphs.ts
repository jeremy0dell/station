export const STATUS_GLYPHS = {
  noAgent: "-",
  starting: "+",
  idle: "○",
  ready: "●",
  attention: "!",
  exited: "x",
  unknown: "?",
} as const;

export const CHECK_GLYPHS = {
  pass: "✓",
  running: "…",
  fallback: "-",
} as const;

export const THROBBERS = {
  working: { kind: "throbber", variant: "braille" },
} as const;
