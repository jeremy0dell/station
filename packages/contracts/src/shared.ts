import { z } from "zod";

export const nonEmptyStringSchema = z.string().min(1);
export const safeTextSchema = nonEmptyStringSchema.refine(
  (value) => !/\n\s*at\s+\S+/.test(value),
  "must not contain stack trace frames",
);
export const optionalProviderDataSchema = z.unknown().optional();
