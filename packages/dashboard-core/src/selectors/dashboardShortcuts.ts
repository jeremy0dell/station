import type { KeyedChoice } from "./selectors.js";

/** Largest one-based base-36 dashboard shortcut (`zz`). */
export const DASHBOARD_SHORTCUT_LIMIT = 1_295;
/** Maximum number of characters in a dashboard shortcut code. */
export const DASHBOARD_SHORTCUT_MAX_CODE_LENGTH = 2;

/** Returns the canonical one-based base-36 shortcut for a zero-based dashboard position. */
export function dashboardShortcutCode(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= DASHBOARD_SHORTCUT_LIMIT) {
    throw new Error(
      `Dashboard shortcut index must be an integer from 0 through ${DASHBOARD_SHORTCUT_LIMIT - 1}: ${index}`,
    );
  }
  return (index + 1).toString(36);
}

/** Assigns at most 1,295 logical shortcuts in the sequence 1-9, a-z, 10-zz. */
export function dashboardShortcutChoices<T>(values: readonly T[]): KeyedChoice<T, string>[] {
  return values
    .slice(0, DASHBOARD_SHORTCUT_LIMIT)
    .map((value, index) => ({ key: dashboardShortcutCode(index), value }));
}

/** Resolves a case-insensitive logical shortcut without replaying synthetic terminal input. */
export function dashboardShortcutValue<T>(
  choices: readonly KeyedChoice<T, string>[],
  input: string,
): T | undefined {
  const code = input.toLowerCase();
  return choices.find((choice) => choice.key === code)?.value;
}

/** Normalizes one typed or pasted alphanumeric chunk for the backtick shortcut prefix. */
export function dashboardShortcutInputChunk(input: string): string | undefined {
  return /^[0-9A-Za-z]+$/u.test(input) ? input.toLowerCase() : undefined;
}
