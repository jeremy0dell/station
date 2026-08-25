import type { KeyedChoice } from "./selectors.js";

const DASHBOARD_SHORTCUT_ALPHABET = "123456789abcdefghijklmnopqrstuvwxyz";

/** Largest one-to-three-character dashboard shortcut (`zzz`). */
export const DASHBOARD_SHORTCUT_LIMIT = 44_135;
/** Maximum number of characters in a dashboard shortcut code. */
export const DASHBOARD_SHORTCUT_MAX_CODE_LENGTH = 3;

/** Returns the canonical bijective base-35 shortcut for a zero-based dashboard position. */
export function dashboardShortcutCode(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= DASHBOARD_SHORTCUT_LIMIT) {
    throw new Error(
      `Dashboard shortcut index must be an integer from 0 through ${DASHBOARD_SHORTCUT_LIMIT - 1}: ${index}`,
    );
  }

  let remaining = index + 1;
  let code = "";
  while (remaining > 0) {
    remaining -= 1;
    code = DASHBOARD_SHORTCUT_ALPHABET[remaining % DASHBOARD_SHORTCUT_ALPHABET.length] + code;
    remaining = Math.floor(remaining / DASHBOARD_SHORTCUT_ALPHABET.length);
  }
  return code;
}

/** Assigns at most 44,135 logical shortcuts in the sequence 1-9, a-z, 11-zzz. */
export function dashboardShortcutChoices<T>(values: readonly T[]): KeyedChoice<T, string>[] {
  return values
    .slice(0, DASHBOARD_SHORTCUT_LIMIT)
    .map((value, index) => ({ key: dashboardShortcutCode(index), value }));
}

/** Resolves a canonical lowercase logical shortcut without replaying synthetic terminal input. */
export function dashboardShortcutValue<T>(
  choices: readonly KeyedChoice<T, string>[],
  input: string,
): T | undefined {
  return choices.find((choice) => choice.key === input)?.value;
}

/** Preserves one typed or pasted command/shortcut chunk accepted by the backtick collector. */
export function dashboardShortcutInputChunk(input: string): string | undefined {
  return /^[1-9A-Za-z]+$/u.test(input) ? input : undefined;
}

/** Identifies a complete canonical lowercase session shortcut. */
export function isDashboardShortcutCode(input: string): boolean {
  return /^[1-9a-z]{1,3}$/u.test(input);
}
