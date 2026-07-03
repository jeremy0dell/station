export type MoonPhase = {
  glyph: string;
  name: string;
};

// Reference new moon (2000-01-06 18:14 UTC) + mean synodic month. The
// approximation drifts by hours over decades — fine for a phase glyph.
const NEW_MOON_EPOCH_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_MONTH_DAYS = 29.530588853;
const DAY_MS = 86_400_000;

const PHASES: readonly MoonPhase[] = [
  { glyph: "🌑", name: "new moon" },
  { glyph: "🌒", name: "waxing crescent" },
  { glyph: "🌓", name: "first quarter" },
  { glyph: "🌔", name: "waxing gibbous" },
  { glyph: "🌕", name: "full moon" },
  { glyph: "🌖", name: "waning gibbous" },
  { glyph: "🌗", name: "last quarter" },
  { glyph: "🌘", name: "waning crescent" },
];

export function moonPhase(date: Date): MoonPhase {
  const daysSinceEpoch = (date.getTime() - NEW_MOON_EPOCH_MS) / DAY_MS;
  const ageDays = positiveModulo(daysSinceEpoch, SYNODIC_MONTH_DAYS);
  // Each phase owns 1/8 of the cycle, centered on its exact moment.
  const index = Math.round((ageDays / SYNODIC_MONTH_DAYS) * PHASES.length) % PHASES.length;
  return PHASES[index] ?? { glyph: "🌑", name: "new moon" };
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export function formatMoonWidget(date: Date): { text: string; compact: string } {
  const phase = moonPhase(date);
  return { text: `${phase.glyph} ${phase.name}`, compact: phase.glyph };
}
