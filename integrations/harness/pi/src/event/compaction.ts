import { compactPayloadByFieldNames, type PayloadCompactionResult } from "@station/harness-shared";
import { compactFieldNamesForPiEvent } from "./catalog.js";
import { normalizePiEventType } from "./compactEvent.js";
import type { PiSupportedEventName } from "./names.js";

export type PiPayloadCompactionResult = {
  payload: unknown;
  compacted: boolean;
  originalByteCount: number | null;
  compactedByteCount: number | null;
  omittedFieldNames: string[];
};

function normalizedEventType(
  eventType: string,
  payload: Record<string, unknown>,
): PiSupportedEventName {
  return normalizePiEventType(
    typeof payload.event_type === "string" ? payload.event_type : eventType,
  );
}

export function compactPiHookPayload(
  eventType: string,
  payload: unknown,
): PiPayloadCompactionResult {
  return compactPayloadByFieldNames(payload, {
    retainedFieldNames: (record) =>
      compactFieldNamesForPiEvent(normalizedEventType(eventType, record)),
    overrideOutput: (record, output) => {
      output.event_type = normalizedEventType(eventType, record);
    },
  }) satisfies PayloadCompactionResult;
}
