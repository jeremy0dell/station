import { compactFieldNamesForPiEvent } from "./catalog.js";
import { normalizePiEventType } from "./compactEvent.js";

export type PiPayloadCompactionResult = {
  payload: unknown;
  compacted: boolean;
  originalByteCount: number | null;
  compactedByteCount: number | null;
  omittedFieldNames: string[];
};

export function compactPiHookPayload(
  eventType: string,
  payload: unknown,
): PiPayloadCompactionResult {
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
  const normalizedEventType = normalizePiEventType(
    typeof payload.event_type === "string" ? payload.event_type : eventType,
  );
  output.event_type = normalizedEventType;
  copiedFields.add("event_type");

  for (const fieldName of compactFieldNamesForPiEvent(normalizedEventType)) {
    if (fieldName === "event_type" || !hasOwn(payload, fieldName)) {
      continue;
    }
    output[fieldName] = payload[fieldName];
    copiedFields.add(fieldName);
  }

  for (const fieldName of Object.keys(payload)) {
    if (!copiedFields.has(fieldName)) {
      omittedFieldNames.add(fieldName);
    }
  }

  const compacted = omittedFieldNames.size > 0;
  return {
    payload: output,
    compacted,
    originalByteCount,
    compactedByteCount: jsonByteCount(output),
    omittedFieldNames: [...omittedFieldNames].sort(),
  };
}

function jsonByteCount(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}
