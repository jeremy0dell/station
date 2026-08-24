// Minimal Bun global surface used by Station production and tests; the app
// intentionally avoids @types/bun to keep the runtime type surface small.
declare const Bun: {
  env: Record<string, string | undefined>;
  stringWidth(input: string): number;
};
