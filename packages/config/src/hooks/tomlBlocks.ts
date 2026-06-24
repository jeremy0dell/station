type TomlBlock = {
  start: number;
  end: number;
  lines: string[];
};

export function appendObserverEventHookBlock(source: string, blockToml: string): string {
  const trimmedSource = source.trimEnd();
  const prefix = trimmedSource.length === 0 ? "" : `${trimmedSource}\n\n`;
  return `${prefix}${blockToml.trim()}\n`;
}

export function removeObserverEventHookBlocksById(source: string, hookId: string): string {
  const lines = source.split("\n");
  const blocks = observerEventHookBlocks(lines).filter(
    (block) => observerEventHookBlockId(block.lines) === hookId,
  );
  if (blocks.length === 0) {
    return source;
  }

  const nextLines: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    nextLines.push(...lines.slice(cursor, block.start));
    cursor = block.end;
  }
  nextLines.push(...lines.slice(cursor));
  return trimRepeatedBlankLines(nextLines).join("\n").trimEnd();
}

function observerEventHookBlocks(lines: readonly string[]): TomlBlock[] {
  const blocks: TomlBlock[] = [];
  let currentStart: number | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const startsHookBlock = isObserverEventHookArrayTable(line);
    if (!startsHookBlock && !isNonObserverEventHookTable(line)) {
      continue;
    }

    if (currentStart !== undefined) {
      blocks.push({
        start: currentStart,
        end: index,
        lines: lines.slice(currentStart, index),
      });
      currentStart = undefined;
    }

    if (startsHookBlock) {
      currentStart = index;
    }
  }

  if (currentStart !== undefined) {
    blocks.push({
      start: currentStart,
      end: lines.length,
      lines: lines.slice(currentStart),
    });
  }

  return blocks;
}

function observerEventHookBlockId(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const doubleQuoted = /^\s*id\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
    if (doubleQuoted?.[1] !== undefined) {
      return JSON.parse(`"${doubleQuoted[1]}"`) as string;
    }
    const singleQuoted = /^\s*id\s*=\s*'([^']*)'\s*(?:#.*)?$/.exec(line);
    if (singleQuoted?.[1] !== undefined) {
      return singleQuoted[1];
    }
  }
  return undefined;
}

function isObserverEventHookArrayTable(line: string): boolean {
  return /^\s*\[\[\s*hooks\.event\s*\]\]\s*(?:#.*)?$/.test(line);
}

function isNonObserverEventHookTable(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("[") &&
    !trimmed.startsWith("[hooks.event.") &&
    !trimmed.startsWith("[[hooks.event]]") &&
    !trimmed.startsWith("[[hooks.event.")
  );
}

function trimRepeatedBlankLines(lines: readonly string[]): string[] {
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
