import type { HarnessIngressRule } from "@station/contracts";

export type ClaudeIngressRule = (typeof claudeIngressRules)[number];

export type ClaudeForwardedEventType = ClaudeIngressRule["eventType"];

const workingMedium = { statusIntents: ["working"], confidences: ["medium"] } as const;

// SubagentStart/SubagentStop/PostToolUseFailure are deliberately absent: SubagentStop fires
// after Stop at turn end and would flip a freshly idle row back to working.
export const claudeIngressRules = [
  {
    provider: "claude",
    eventType: "SessionStart",
    statusIntents: ["starting"],
    confidences: ["high"],
  },
  { provider: "claude", eventType: "UserPromptSubmit", ...workingMedium },
  { provider: "claude", eventType: "PreToolUse", ...workingMedium },
  { provider: "claude", eventType: "PostToolUse", ...workingMedium },
  {
    provider: "claude",
    eventType: "PermissionRequest",
    statusIntents: ["needs_attention"],
    confidences: ["high"],
  },
  {
    provider: "claude",
    eventType: "Notification",
    statusIntents: ["needs_attention", "idle"],
    confidences: ["medium", "high"],
  },
  { provider: "claude", eventType: "PreCompact", ...workingMedium },
  {
    provider: "claude",
    eventType: "Stop",
    statusIntents: ["idle", "working"],
    confidences: ["medium", "high"],
  },
  {
    provider: "claude",
    eventType: "SessionEnd",
    statusIntents: ["exited"],
    confidences: ["high"],
  },
] as const satisfies readonly HarnessIngressRule<"claude", string>[];

export const claudeForwardedEventTypes = claudeIngressRules.map((rule) => rule.eventType);

export function claudeIngressRuleForEventType(value: string): ClaudeIngressRule | undefined {
  return claudeIngressRules.find((rule) => rule.eventType === value);
}

export function isClaudeForwardedEventType(value: string): value is ClaudeForwardedEventType {
  return claudeIngressRuleForEventType(value) !== undefined;
}
