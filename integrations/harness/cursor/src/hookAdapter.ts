// Adapts Cursor hook delivery into STATION ProviderHookEvent / HarnessEventReport.
// STATION ingress flow: docs/harness-ingress.md.
import { createHarnessHookAdapter } from "@station/harness-shared";
import { compactCursorProviderHookPayload } from "./compaction.js";
import { cursorProviderHookPayloadToHarnessEventReport } from "./events.js";

export const cursorHookAdapter = createHarnessHookAdapter({
  provider: "cursor",
  compactHookPayload: (event) => compactCursorProviderHookPayload(event.payload),
  hookPayloadToHarnessEventReport: cursorProviderHookPayloadToHarnessEventReport,
});
