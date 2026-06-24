// Minimal Bun global surface used by gated tests; the app intentionally
// avoids @types/bun to keep the experiment's type surface small.
declare const Bun: {
  env: Record<string, string | undefined>;
};
