import { createHarnessHookAdapter } from "@station/harness-shared";
import { compactOpenCodeHookPayload } from "./compaction.js";
import {
  normalizeOpenCodeEventType,
  openCodeHookPayloadToHarnessEventReport,
  parseOpenCodeCompactEvent,
} from "./events.js";
import { isOpenCodeForwardedEventType } from "./ingressRules.js";

/**
 * ADAPTER
 *
 * Normalizes OpenCode plugin hooks into shared provider-event and harness-report contracts.
 */
export const openCodeHookAdapter = createHarnessHookAdapter({
  provider: "opencode",
  isForwardedEventType: isOpenCodeForwardedEventType,
  compactHookPayload: (event) => compactOpenCodeHookPayload(event.payload),
  hookPayloadToHarnessEventReport: openCodeHookPayloadToHarnessEventReport,
  normalizeEventName: normalizeOpenCodeEventType,
  hookPayloadObservedAt: (event) =>
    parseOpenCodeCompactEvent(event.payload).observed_at ?? event.receivedAt,
});
