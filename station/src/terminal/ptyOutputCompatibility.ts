import type { TerminalOutputCompatibility } from "@station/contracts";
import { CsiSequence } from "./protocol/csi.js";
import { CsiCommand } from "./protocol/identifiers.js";
import { VtPrefix } from "./protocol/syntax.js";

const START = `${VtPrefix.Csi}1;`;
const MAX_PARAMETER_DIGITS = 6;

export type PtyOutputCompatibilityResult = {
  data: string;
  rewriteCount: number;
};

export type PtyOutputCompatibility = {
  transform(data: string, rows: number): PtyOutputCompatibilityResult;
  flush(): string;
};

type Candidate =
  | {
      kind: "complete";
      end: number;
      repaintStart: number;
      bottom: number;
      count: number;
    }
  | { kind: "incomplete" }
  | { kind: "invalid" };

type Digits =
  | { kind: "complete"; end: number; value: string }
  | { kind: "incomplete" }
  | { kind: "invalid" };

/**
 * Rewrites only Codex's exact row-1 region-scroll-and-repaint idiom into an
 * equivalent full-screen scroll, preserving xterm history.
 * Remove this compatibility layer once Codex fixes
 * https://github.com/openai/codex/issues/27644, Station requires that release,
 * and raw-capture plus manual scrollback verification pass without the policy.
 * Incomplete candidates retain only the fixed literals and three bounded parameters.
 */
export function createPtyOutputCompatibility(
  compatibility?: TerminalOutputCompatibility,
): PtyOutputCompatibility {
  if (compatibility === undefined) {
    return {
      transform: (data) => ({ data, rewriteCount: 0 }),
      flush: () => "",
    };
  }

  let carry = "";
  return {
    transform(chunk, rows) {
      const data = carry + chunk;
      carry = "";
      let cursor = 0;
      let output = "";
      let rewriteCount = 0;

      while (cursor < data.length) {
        const start = data.indexOf(START, cursor);
        if (start < 0) {
          const carryLength = partialStartLength(data, cursor);
          const outputEnd = data.length - carryLength;
          output += data.slice(cursor, outputEnd);
          carry = data.slice(outputEnd);
          break;
        }

        output += data.slice(cursor, start);
        const candidate = parseCandidate(data, start);
        if (candidate.kind === "incomplete") {
          carry = data.slice(start);
          break;
        }
        if (candidate.kind === "invalid") {
          output += data[start];
          cursor = start + 1;
          continue;
        }

        const original = data.slice(start, candidate.end);
        if (
          candidate.bottom > 0 &&
          candidate.bottom < rows &&
          candidate.count <= candidate.bottom
        ) {
          output += replacement(candidate.count) + data.slice(candidate.repaintStart, candidate.end);
          rewriteCount += 1;
        } else {
          output += original;
        }
        cursor = candidate.end;
      }

      return { data: output, rewriteCount };
    },
    flush() {
      const pending = carry;
      carry = "";
      return pending;
    },
  };
}

function parseCandidate(data: string, start: number): Candidate {
  const bottom = readDigits(data, start + START.length, true);
  if (bottom.kind !== "complete") {
    return bottom;
  }
  let cursor = bottom.end;
  if (data[cursor] === undefined) {
    return { kind: "incomplete" };
  }
  if (data[cursor] !== CsiCommand.SetScrollingRegion.final) {
    return { kind: "invalid" };
  }
  cursor += 1;

  const scrollCsi = requireLiteral(data, cursor, VtPrefix.Csi);
  if (scrollCsi !== "complete") {
    return { kind: scrollCsi };
  }
  cursor += VtPrefix.Csi.length;

  const count = readDigits(data, cursor, false);
  if (count.kind !== "complete") {
    return count;
  }
  cursor = count.end;
  if (data[cursor] === undefined) {
    return { kind: "incomplete" };
  }
  if (data[cursor] !== CsiCommand.ScrollUp.final) {
    return { kind: "invalid" };
  }
  cursor += 1;

  const reset = CsiSequence.ResetScrollRegion;
  const resetStatus = requireLiteral(data, cursor, reset);
  if (resetStatus !== "complete") {
    return { kind: resetStatus };
  }
  cursor += reset.length;

  const repaintStart = cursor;
  const positionCsi = requireLiteral(data, cursor, VtPrefix.Csi);
  if (positionCsi !== "complete") {
    return { kind: positionCsi };
  }
  cursor += VtPrefix.Csi.length;

  const row = readDigits(data, cursor, true);
  if (row.kind !== "complete") {
    return row;
  }
  cursor = row.end;
  const repaintTail = `;1${CsiCommand.CursorPosition.final}${VtPrefix.Csi}${CsiCommand.EraseInDisplay.final}`;
  const repaintStatus = requireLiteral(data, cursor, repaintTail);
  if (repaintStatus !== "complete") {
    return { kind: repaintStatus };
  }
  cursor += repaintTail.length;

  const parsedCount = count.value.length === 0 || count.value === "0" ? 1 : Number(count.value);
  const parsedBottom = Number(bottom.value);
  if (Number(row.value) !== parsedBottom - parsedCount + 1) {
    return { kind: "invalid" };
  }
  return {
    kind: "complete",
    end: cursor,
    repaintStart,
    bottom: parsedBottom,
    count: parsedCount,
  };
}

function readDigits(data: string, start: number, required: boolean): Digits {
  let cursor = start;
  while (cursor < data.length && isDigit(data[cursor])) {
    cursor += 1;
    if (cursor - start > MAX_PARAMETER_DIGITS) {
      return { kind: "invalid" };
    }
  }
  if (cursor === data.length) {
    return { kind: "incomplete" };
  }
  if (required && cursor === start) {
    return { kind: "invalid" };
  }
  return { kind: "complete", end: cursor, value: data.slice(start, cursor) };
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function requireLiteral(
  data: string,
  start: number,
  literal: string,
): "complete" | "incomplete" | "invalid" {
  const available = data.slice(start, start + literal.length);
  if (available === literal) {
    return "complete";
  }
  return literal.startsWith(available) && start + available.length === data.length
    ? "incomplete"
    : "invalid";
}

function partialStartLength(data: string, start: number): number {
  const maxLength = Math.min(START.length - 1, data.length - start);
  for (let length = maxLength; length > 0; length -= 1) {
    if (START.startsWith(data.slice(data.length - length))) {
      return length;
    }
  }
  return 0;
}

function replacement(count: number): string {
  return `${CsiSequence.ResetScrollRegion}${VtPrefix.Csi}999;1H${"\n".repeat(count)}${CsiSequence.CursorHome}`;
}
