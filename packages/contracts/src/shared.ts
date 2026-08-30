import { z } from "zod";

/** JavaScript line terminators used by bounded and user-safe text contracts. */
export const textLineTerminatorPattern = /\r\n|[\n\r\u2028\u2029]/u;

/** Stable JavaScript code-unit ordering for schema validation and wire producers. */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export const nonEmptyStringSchema = z.string().min(1);
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const userFacingTitleSchema = z.string().trim().min(1);
export const safeTextSchema = nonEmptyStringSchema.refine(
  (value) => !/(?:\r\n|[\n\r\u2028\u2029])\s*at\s+\S+/u.test(value),
  "must not contain stack trace frames",
);
export const optionalProviderDataSchema = z.unknown().optional();
