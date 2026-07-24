// Adapts Codex hook delivery into STATION ProviderHookEvent / HarnessEventReport.
// Upstream hook contract: https://developers.openai.com/codex/hooks
// STATION ingress flow: docs/harness-ingress.md.
import { createHarnessHookAdapter } from "@station/harness-shared";
import { compactCodexHookPayload } from "./compaction.js";
import {
  codexHookPayloadReportId,
  codexHookPayloadToHarnessEventReport,
  codexStationIdentityCwdMismatch,
} from "./events.js";
import { isCodexForwardedEventType } from "./ingressRules.js";

/**
 * ADAPTER
 *
 * Normalizes Codex hook delivery into shared provider-event and harness-report contracts.
 * Inherited Station identity is authoritative only when Codex cwd remains in the stamped worktree.
 */
export const codexHookAdapter = createHarnessHookAdapter({
  provider: "codex",
  isForwardedEventType: isCodexForwardedEventType,
  acceptCwdFallback: true,
  compactHookPayload: (event) => compactCodexHookPayload(event.payload),
  hookPayloadReportId: (event) => codexHookPayloadReportId(event.payload, event.receivedAt),
  hookPayloadToHarnessEventReport: codexHookPayloadToHarnessEventReport,
  corroborateCwdMismatch: codexStationIdentityCwdMismatch,
});
