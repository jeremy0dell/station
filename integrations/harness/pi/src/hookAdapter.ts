// Adapts Pi hook delivery into STATION ProviderHookEvent / HarnessEventReport.
// Contract: STATION-native (first-party Pi harness, no external upstream) — see packages/contracts.
// STATION ingress flow: docs/harness-ingress.md.
import { createHarnessHookAdapter } from "@station/harness-shared";
import { normalizePiEventType } from "./event/compactEvent.js";
import { compactPiHookPayload } from "./event/compaction.js";
import { piHookPayloadToHarnessEventReport } from "./event/mapping.js";

export const piHookAdapter = createHarnessHookAdapter({
  provider: "pi",
  compactHookPayload: (event) => compactPiHookPayload(event.event, event.payload),
  hookPayloadToHarnessEventReport: piHookPayloadToHarnessEventReport,
  normalizeEventName: normalizePiEventType,
});
