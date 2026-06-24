import { compactPayloadByFieldNames, type PayloadCompactionResult } from "@station/harness-shared";
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
  return compactPayloadByFieldNames(payload, {
    retainedFieldNames: (record) => {
      const normalizedEventType = normalizePiEventType(
        typeof record.event_type === "string" ? record.event_type : eventType,
      );
      return compactFieldNamesForPiEvent(normalizedEventType);
    },
    overrideOutput: (record, output) => {
      output.event_type = normalizePiEventType(
        typeof record.event_type === "string" ? record.event_type : eventType,
      );
    },
  }) satisfies PayloadCompactionResult;
}
