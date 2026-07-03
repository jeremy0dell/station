/** Line-level helpers shared by the config.toml mutation writers. */

/** Collapses the blank-line runs that removing blocks leaves behind. */
export function trimRepeatedBlankLines(lines: readonly string[]): string[] {
  const result: string[] = [];
  let previousBlank = false;
  for (const line of lines) {
    const blank = line.trim().length === 0;
    if (blank && previousBlank) {
      continue;
    }
    result.push(line);
    previousBlank = blank;
  }
  return result;
}

/** TOML basic strings share JSON's escape grammar. */
export function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}
