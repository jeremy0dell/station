// Adapts Claude Code hook delivery into STATION ProviderHookEvent / HarnessEventReport.
// Upstream hook contract: https://docs.anthropic.com/en/docs/claude-code/hooks
// STATION ingress flow: docs/harness-ingress.md.
import { createHarnessHookAdapter } from "@station/harness-shared";
import { compactClaudeHookPayload } from "./compaction.js";
import { claudeHookPayloadReportId, claudeHookPayloadToHarnessEventReport } from "./events.js";
import { isClaudeForwardedEventType } from "./ingressRules.js";

export const claudeHookAdapter = createHarnessHookAdapter({
  provider: "claude",
  isForwardedEventType: isClaudeForwardedEventType,
  acceptCwdFallback: true,
  compactHookPayload: (event) => compactClaudeHookPayload(event.payload),
  hookPayloadReportId: (event) => claudeHookPayloadReportId(event.payload, event.receivedAt),
  hookPayloadToHarnessEventReport: claudeHookPayloadToHarnessEventReport,
});
