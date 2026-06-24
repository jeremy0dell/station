import type { z } from "zod";

export type MutableRecord = Record<string, unknown>;
export type KeyMap = Record<string, string>;
export type ChildNormalizers = Record<string, (value: unknown) => unknown>;

export function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];

  if (issue === undefined) {
    return "schema validation failed";
  }

  const path = issue.path.join(".");

  return path.length > 0 ? `${path} ${issue.message}` : issue.message;
}

export function isRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}
