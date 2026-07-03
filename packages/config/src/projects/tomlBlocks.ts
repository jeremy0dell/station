import { quoteTomlString, trimRepeatedBlankLines } from "../tomlEdit.js";
import { projectConfigSafeError } from "./errors.js";
import type { MinimalProjectBlock } from "./types.js";

export function appendProjectBlock(source: string, block: MinimalProjectBlock): string {
  const withoutEmptyProjects = removeTopLevelEmptyProjectsAssignment(source);
  const trimmed = withoutEmptyProjects.trimEnd();
  const prefix = trimmed.length === 0 ? "" : `${trimmed}\n\n`;
  return `${prefix}${formatMinimalProjectBlock(block)}\n`;
}

export function removeProjectBlock(source: string, projectId: string): string {
  const lines = source.split("\n");
  const blocks = projectBlocks(lines);
  const block = blocks.find((candidate) => projectBlockId(candidate.lines) === projectId);
  if (block === undefined) {
    throw projectConfigSafeError({
      code: "PROJECT_BLOCK_NOT_FOUND",
      message: `Could not find a [[projects]] block for "${projectId}" in config.toml.`,
      projectId,
    });
  }

  const nextLines = [...lines.slice(0, block.start), ...lines.slice(block.end)];
  const sourceWithoutBlock = trimRepeatedBlankLines(nextLines).join("\n").trimEnd();
  if (projectBlocks(sourceWithoutBlock.split("\n")).length > 0) {
    return `${sourceWithoutBlock}\n`;
  }
  return `${insertTopLevelEmptyProjectsAssignment(sourceWithoutBlock)}\n`;
}

export function setProjectDefaultHarness(
  source: string,
  projectId: string,
  harness: string,
): string {
  const lines = source.split("\n");
  const blocks = projectBlocks(lines);
  const block = blocks.find((candidate) => projectBlockId(candidate.lines) === projectId);
  if (block === undefined) {
    throw projectConfigSafeError({
      code: "PROJECT_BLOCK_NOT_FOUND",
      message: `Could not find a [[projects]] block for "${projectId}" in config.toml.`,
      projectId,
    });
  }

  const defaultsStart = block.lines.findIndex(isProjectDefaultsTable);
  if (defaultsStart !== -1) {
    const start = block.start + defaultsStart;
    const end = nextProjectSubtableIndex(lines, start + 1, block.end);
    const harnessIndex = lines
      .slice(start + 1, end)
      .findIndex((line) => /^\s*harness\s*=/.test(line));
    if (harnessIndex !== -1) {
      const absolute = start + 1 + harnessIndex;
      const nextLines = [...lines];
      nextLines[absolute] = replaceTomlStringValue(nextLines[absolute] ?? "", "harness", harness);
      return `${trimRepeatedBlankLines(nextLines).join("\n").trimEnd()}\n`;
    }
    const nextLines = [
      ...lines.slice(0, start + 1),
      `harness = ${quoteTomlString(harness)}`,
      ...lines.slice(start + 1),
    ];
    return `${trimRepeatedBlankLines(nextLines).join("\n").trimEnd()}\n`;
  }

  const insertAt = firstProjectSubtableIndex(block.lines);
  const absoluteInsertAt = insertAt === -1 ? block.end : block.start + insertAt;
  const nextLines = [
    ...lines.slice(0, absoluteInsertAt),
    "",
    "[projects.defaults]",
    `harness = ${quoteTomlString(harness)}`,
    ...lines.slice(absoluteInsertAt),
  ];
  return `${trimRepeatedBlankLines(nextLines).join("\n").trimEnd()}\n`;
}

function projectBlocks(lines: string[]): Array<{ start: number; end: number; lines: string[] }> {
  const blocks: Array<{ start: number; end: number; lines: string[] }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isProjectArrayTable(lines[index] ?? "")) {
      continue;
    }
    const start = index;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? "";
      if (isProjectArrayTable(line) || isNonProjectTable(line)) {
        end = next;
        break;
      }
    }
    blocks.push({ start, end, lines: lines.slice(start, end) });
    index = end - 1;
  }
  return blocks;
}

function projectBlockId(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = /^\s*id\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
    if (match?.[1] !== undefined) {
      return JSON.parse(`"${match[1]}"`) as string;
    }
  }
  return undefined;
}

function isProjectArrayTable(line: string): boolean {
  return /^\s*\[\[\s*projects\s*\]\]\s*(?:#.*)?$/.test(line);
}

function isProjectDefaultsTable(line: string): boolean {
  return /^\s*\[\s*projects\.defaults\s*\]\s*(?:#.*)?$/.test(line);
}

function firstProjectSubtableIndex(lines: readonly string[]): number {
  return lines.findIndex((line) => /^\s*\[\s*projects\.[^\]]+\]\s*(?:#.*)?$/.test(line));
}

function nextProjectSubtableIndex(lines: readonly string[], start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (/^\s*\[\s*projects\.[^\]]+\]\s*(?:#.*)?$/.test(lines[index] ?? "")) {
      return index;
    }
  }
  return end;
}

function isNonProjectTable(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("[") &&
    !trimmed.startsWith("[projects.") &&
    !trimmed.startsWith("[[projects]]") &&
    !trimmed.startsWith("[[projects.")
  );
}

function removeTopLevelEmptyProjectsAssignment(source: string): string {
  const lines = source.split("\n");
  const result: string[] = [];
  let inTopLevel = true;
  let removed = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && !trimmed.startsWith("[[projects]]")) {
      inTopLevel = false;
    }
    if (!removed && inTopLevel && /^\s*projects\s*=\s*\[\s*\]\s*(?:#.*)?$/.test(line)) {
      removed = true;
      continue;
    }
    result.push(line);
  }
  return trimRepeatedBlankLines(result).join("\n");
}

function insertTopLevelEmptyProjectsAssignment(source: string): string {
  if (/^\s*projects\s*=\s*\[\s*\]\s*(?:#.*)?$/m.test(source)) {
    return source;
  }

  const lines = source.split("\n");
  const insertAt = firstTableLineIndex(lines);
  const nextLines = [...lines.slice(0, insertAt), "projects = []", "", ...lines.slice(insertAt)];
  return trimRepeatedBlankLines(nextLines).join("\n").trimEnd();
}

function firstTableLineIndex(lines: readonly string[]): number {
  const index = lines.findIndex((line) => line.trim().startsWith("["));
  return index === -1 ? lines.length : index;
}

function formatMinimalProjectBlock(block: MinimalProjectBlock): string {
  return [
    "[[projects]]",
    `id = ${quoteTomlString(block.id)}`,
    `label = ${quoteTomlString(block.label)}`,
    `root = ${quoteTomlString(block.root)}`,
  ].join("\n");
}

function replaceTomlStringValue(line: string, key: string, value: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^(\\s*${escapedKey}\\s*=\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*')(\\s*(?:#.*)?)$`,
  ).exec(line);
  if (match === null) {
    return `${key} = ${quoteTomlString(value)}`;
  }
  return `${match[1]}${quoteTomlString(value)}${match[2]}`;
}
