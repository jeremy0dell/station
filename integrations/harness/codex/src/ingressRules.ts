import type { HarnessIngressRule } from "@station/contracts";

const workingMedium = { statusIntents: ["working"], confidences: ["medium"] } as const;

// SubagentStop is deliberately absent because it may arrive after the parent Stop and
// cannot assert parent liveness without a typed child roster.
const codexNativeIngressRules = [
  {
    provider: "codex",
    eventType: "SessionStart",
    statusIntents: ["starting"],
    confidences: ["high"],
  },
  { provider: "codex", eventType: "UserPromptSubmit", ...workingMedium },
  {
    provider: "codex",
    eventType: "PreToolUse",
    statusIntents: ["working", "needs_attention"],
    confidences: ["medium", "high"],
  },
  {
    provider: "codex",
    eventType: "PermissionRequest",
  },
  {
    provider: "codex",
    eventType: "PostToolUse",
    statusIntents: ["working"],
    confidences: ["medium", "high"],
  },
  { provider: "codex", eventType: "PreCompact", ...workingMedium },
  { provider: "codex", eventType: "PostCompact", ...workingMedium },
  { provider: "codex", eventType: "SubagentStart", ...workingMedium },
  {
    provider: "codex",
    eventType: "Stop",
    statusIntents: ["idle", "working"],
    confidences: ["high", "medium"],
  },
] as const satisfies readonly HarnessIngressRule<"codex", string>[];

export const codexIngressRules = [
  ...codexNativeIngressRules,
  {
    provider: "codex",
    eventType: "StationApprovalPromptOpened",
    statusIntents: ["needs_attention"],
    confidences: ["high"],
  },
] as const satisfies readonly HarnessIngressRule<"codex", string>[];

export type CodexIngressRule = (typeof codexIngressRules)[number];

export const codexForwardedEventTypes = codexNativeIngressRules.map((rule) => rule.eventType);

export type CodexForwardedEventType = (typeof codexForwardedEventTypes)[number];

const codexIngressRuleByEventType: ReadonlyMap<string, CodexIngressRule> = new Map(
  codexIngressRules.map((rule) => [rule.eventType, rule]),
);
const codexForwardedEventTypeSet = new Set<string>(codexForwardedEventTypes);

export function codexIngressRuleForEventType(value: string): CodexIngressRule | undefined {
  return codexIngressRuleByEventType.get(value);
}

export function isCodexForwardedEventType(value: string): value is CodexForwardedEventType {
  return codexForwardedEventTypeSet.has(value);
}

export function isCodexIngressEventType(value: string): boolean {
  return codexIngressRuleByEventType.has(value);
}
