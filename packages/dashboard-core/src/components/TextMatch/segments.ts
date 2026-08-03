export type TextMatchRange = {
  start: number;
  end: number;
};

export type TextMatchSegment = {
  text: string;
  matched: boolean;
};

/** Splits display text at match offsets while safely ignoring ranges outside its visible bounds. */
export function textMatchSegments(
  text: string,
  ranges: readonly TextMatchRange[],
): TextMatchSegment[] {
  if (ranges.length === 0) {
    return [{ text, matched: false }];
  }

  const segments: TextMatchSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, clampTextMatchOffset(range.start, text.length));
    const end = clampTextMatchOffset(range.end, text.length);
    if (end <= start) {
      continue;
    }
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), matched: false });
    }
    segments.push({ text: text.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), matched: false });
  }
  return segments;
}

function clampTextMatchOffset(offset: number, textLength: number): number {
  return Math.min(textLength, Math.max(0, offset));
}
