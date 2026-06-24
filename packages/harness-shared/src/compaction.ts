import { isRecord } from "@station/runtime";

export type PayloadCompactionResult = {
  payload: unknown;
  compacted: boolean;
  originalByteCount: number | null;
  compactedByteCount: number | null;
  omittedFieldNames: string[];
};

export type CompactPayloadOptions = {
  retainedFieldNames: readonly string[] | ((payload: Record<string, unknown>) => readonly string[]);
  compactObjectFieldNames?: readonly string[];
  compactStringFieldNames?: readonly string[];
  nullWhenPresentFieldNames?: readonly string[];
  overrideOutput?: (payload: Record<string, unknown>, output: Record<string, unknown>) => void;
};

export function jsonByteCount(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

export function compactPayloadByFieldNames(
  payload: unknown,
  options: CompactPayloadOptions,
): PayloadCompactionResult {
  const originalByteCount = jsonByteCount(payload);
  if (!isRecord(payload)) {
    return {
      payload,
      compacted: false,
      originalByteCount,
      compactedByteCount: originalByteCount,
      omittedFieldNames: [],
    };
  }

  const output: Record<string, unknown> = {};
  const copiedFields = new Set<string>();
  const omittedFieldNames = new Set<string>();
  const fieldNames =
    typeof options.retainedFieldNames === "function"
      ? options.retainedFieldNames(payload)
      : options.retainedFieldNames;
  const compactedFieldNames = new Set([
    ...(options.compactObjectFieldNames ?? []),
    ...(options.compactStringFieldNames ?? []),
    ...(options.nullWhenPresentFieldNames ?? []),
  ]);

  options.overrideOutput?.(payload, output);
  for (const fieldName of Object.keys(output)) copiedFields.add(fieldName);

  for (const fieldName of fieldNames) {
    if (!Object.hasOwn(payload, fieldName) || compactedFieldNames.has(fieldName)) continue;
    output[fieldName] = payload[fieldName];
    copiedFields.add(fieldName);
  }
  for (const fieldName of options.compactObjectFieldNames ?? []) {
    if (!Object.hasOwn(payload, fieldName)) continue;
    output[fieldName] = { compacted: true, originalBytes: jsonByteCount(payload[fieldName]) };
    copiedFields.add(fieldName);
    omittedFieldNames.add(fieldName);
  }
  for (const fieldName of options.compactStringFieldNames ?? []) {
    if (!Object.hasOwn(payload, fieldName)) continue;
    output[fieldName] = compactedTextPlaceholder(fieldName, jsonByteCount(payload[fieldName]));
    copiedFields.add(fieldName);
    omittedFieldNames.add(fieldName);
  }
  for (const fieldName of options.nullWhenPresentFieldNames ?? []) {
    if (!Object.hasOwn(payload, fieldName)) continue;
    output[fieldName] = null;
    copiedFields.add(fieldName);
    if (payload[fieldName] !== null) omittedFieldNames.add(fieldName);
  }
  for (const fieldName of Object.keys(payload)) {
    if (!copiedFields.has(fieldName)) omittedFieldNames.add(fieldName);
  }

  return {
    payload: output,
    compacted: omittedFieldNames.size > 0,
    originalByteCount,
    compactedByteCount: jsonByteCount(output),
    omittedFieldNames: [...omittedFieldNames].sort(),
  };
}

function compactedTextPlaceholder(fieldName: string, byteCount: number | null): string {
  const bytes = byteCount === null ? "unknown" : String(byteCount);
  return `[station compacted ${fieldName}: ${bytes} bytes]`;
}
