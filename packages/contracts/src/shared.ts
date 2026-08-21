import { z } from "zod";

/** JavaScript line terminators used by bounded and user-safe text contracts. */
export const textLineTerminatorPattern = /\r\n|[\n\r\u2028\u2029]/u;

export const nonEmptyStringSchema = z.string().min(1);
export const userFacingTitleSchema = z.string().trim().min(1);
export const safeTextSchema = nonEmptyStringSchema.refine(
  (value) => !/(?:\r\n|[\n\r\u2028\u2029])\s*at\s+\S+/u.test(value),
  "must not contain stack trace frames",
);
export const optionalProviderDataSchema = z.unknown().optional();
