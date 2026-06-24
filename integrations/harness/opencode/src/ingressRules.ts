import type { HarnessIngressRule } from "@station/contracts";

const workingMedium = { statusIntents: ["working"], confidences: ["medium"] } as const;

export const openCodeIngressRules = [
  { provider: "opencode", eventType: "command.executed", ...workingMedium },
  {
    provider: "opencode",
    eventType: "permission.asked",
    statusIntents: ["needs_attention"],
    confidences: ["high"],
  },
  {
    provider: "opencode",
    eventType: "permission.replied",
    statusIntents: ["idle", "working"],
    confidences: ["medium", "high"],
  },
  {
    provider: "opencode",
    eventType: "question.asked",
    statusIntents: ["needs_attention"],
    confidences: ["high"],
  },
  {
    provider: "opencode",
    eventType: "question.rejected",
    statusIntents: ["idle"],
    confidences: ["medium"],
  },
  {
    provider: "opencode",
    eventType: "question.replied",
    statusIntents: ["working"],
    confidences: ["high"],
  },
  { provider: "opencode", eventType: "session.compacted", ...workingMedium },
  {
    provider: "opencode",
    eventType: "session.created",
    statusIntents: ["starting"],
    confidences: ["medium"],
  },
  {
    provider: "opencode",
    eventType: "session.deleted",
    statusIntents: ["exited"],
    confidences: ["high"],
  },
  {
    provider: "opencode",
    eventType: "session.error",
    statusIntents: ["needs_attention"],
    confidences: ["high"],
  },
  {
    provider: "opencode",
    eventType: "session.idle",
    statusIntents: ["idle"],
    confidences: ["high"],
  },
  { provider: "opencode", eventType: "session.next.compaction.delta", ...workingMedium },
  { provider: "opencode", eventType: "session.next.compaction.ended", ...workingMedium },
  { provider: "opencode", eventType: "session.next.compaction.started", ...workingMedium },
  { provider: "opencode", eventType: "session.next.prompted", ...workingMedium },
  { provider: "opencode", eventType: "session.next.shell.ended", ...workingMedium },
  { provider: "opencode", eventType: "session.next.shell.started", ...workingMedium },
  { provider: "opencode", eventType: "session.next.step.ended", ...workingMedium },
  { provider: "opencode", eventType: "session.next.step.failed", ...workingMedium },
  { provider: "opencode", eventType: "session.next.step.started", ...workingMedium },
  { provider: "opencode", eventType: "session.next.synthetic", ...workingMedium },
  { provider: "opencode", eventType: "session.next.tool.called", ...workingMedium },
  { provider: "opencode", eventType: "session.next.tool.failed", ...workingMedium },
  { provider: "opencode", eventType: "session.next.tool.input.delta", ...workingMedium },
  { provider: "opencode", eventType: "session.next.tool.input.ended", ...workingMedium },
  { provider: "opencode", eventType: "session.next.tool.input.started", ...workingMedium },
  { provider: "opencode", eventType: "session.next.tool.progress", ...workingMedium },
  { provider: "opencode", eventType: "session.next.tool.success", ...workingMedium },
  {
    provider: "opencode",
    eventType: "session.status",
    statusIntents: ["idle", "working"],
    confidences: ["medium", "high"],
  },
  { provider: "opencode", eventType: "tool.execute.after", ...workingMedium },
  { provider: "opencode", eventType: "tool.execute.before", ...workingMedium },
  {
    provider: "opencode",
    eventType: "tui.command.execute",
    statusIntents: ["idle"],
    confidences: ["medium"],
  },
] as const satisfies readonly HarnessIngressRule<"opencode", string>[];

export type OpenCodeIngressRule = (typeof openCodeIngressRules)[number];

export const openCodeForwardedEventTypes = openCodeIngressRules.map((rule) => rule.eventType);

export type OpenCodeForwardedEventType = (typeof openCodeForwardedEventTypes)[number];

const openCodeIngressRuleByEventType: ReadonlyMap<string, OpenCodeIngressRule> = new Map(
  openCodeIngressRules.map((rule) => [rule.eventType, rule]),
);

export function openCodeIngressRuleForEventType(value: string): OpenCodeIngressRule | undefined {
  return openCodeIngressRuleByEventType.get(value);
}

export function isOpenCodeForwardedEventType(value: string): value is OpenCodeForwardedEventType {
  return openCodeIngressRuleByEventType.has(value);
}
