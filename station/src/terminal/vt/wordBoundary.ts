/**
 * Word/line ranges within a single row's text, for double- and triple-click
 * selection. Column indices are treated as character indices (exact for the
 * common single-width case; wide chars can be off by their extra cell, which
 * only nudges a word edge — acceptable for a click target).
 */
export type CharRange = { start: number; end: number };

/**
 * The run of same-class characters under `col` — a word (non-whitespace) or a
 * whitespace run, mirroring how terminals expand a double-click. `end` is
 * exclusive.
 */
export function wordRangeAt(text: string, col: number): CharRange {
  if (text.length === 0) {
    return { start: 0, end: 0 };
  }
  const index = Math.min(Math.max(col, 0), text.length - 1);
  const wordClass = isWordChar(text[index]);
  let start = index;
  let end = index + 1;
  while (start > 0 && isWordChar(text[start - 1]) === wordClass) {
    start -= 1;
  }
  while (end < text.length && isWordChar(text[end]) === wordClass) {
    end += 1;
  }
  return { start, end };
}

/** The whole logical line, trailing whitespace dropped (triple-click). */
export function lineRangeAt(text: string): CharRange {
  return { start: 0, end: text.replace(/\s+$/, "").length };
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /\S/.test(char);
}
