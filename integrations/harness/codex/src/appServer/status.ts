import type { ObservedStatus } from "@station/contracts";
import type { CodexAppServerEvent } from "./types.js";

export function statusFromCodexAppServerEvent(
  event: CodexAppServerEvent,
  observedAt: string,
): ObservedStatus | undefined {
  switch (event.kind) {
    case "thread-status-changed":
      return statusFromThreadStatus(event, observedAt);
    case "turn-completed":
      return statusFromTurnCompletion(event.turnStatus, observedAt);
    case "item-completed":
      // Plan updates are progress; Codex reserves completed plan items for proposed plans.
      if (event.itemType === "plan") {
        return {
          value: "needs_attention",
          confidence: "high",
          reason: "Codex proposed a plan.",
          source: "harness_event",
          updatedAt: observedAt,
          attention: "plan_approval",
        };
      }
      return undefined;
    case "server-request":
      return statusFromServerRequest(event.method, observedAt);
    case "error":
      return {
        value: "stuck",
        confidence: "high",
        reason: event.message ?? "Codex app-server reported an error.",
        source: "harness_event",
        updatedAt: observedAt,
      };
    case "turn-started":
    case "plan-delta":
    case "turn-plan-updated":
    case "server-request-resolved":
    case "unsupported":
      return undefined;
  }
}

function statusFromThreadStatus(
  event: Extract<CodexAppServerEvent, { kind: "thread-status-changed" }>,
  observedAt: string,
): ObservedStatus | undefined {
  if (event.threadStatusType === "active") {
    if (event.activeFlags.includes("waitingOnApproval")) {
      return {
        value: "needs_attention",
        confidence: "high",
        reason: "Codex is waiting for approval.",
        source: "harness_event",
        updatedAt: observedAt,
        attention: "tool_approval",
      };
    }
    if (event.activeFlags.includes("waitingOnUserInput")) {
      return {
        value: "needs_attention",
        confidence: "high",
        reason: "Codex is waiting for user input.",
        source: "harness_event",
        updatedAt: observedAt,
        attention: "question",
      };
    }
    return undefined;
  }
  if (event.threadStatusType === "systemError") {
    return {
      value: "stuck",
      confidence: "high",
      reason: "Codex thread reported a system error.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  return undefined;
}

function statusFromTurnCompletion(
  turnStatus: string,
  observedAt: string,
): ObservedStatus | undefined {
  if (turnStatus === "failed") {
    return {
      value: "stuck",
      confidence: "high",
      reason: "Codex turn failed.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (turnStatus === "interrupted") {
    return {
      value: "idle",
      confidence: "high",
      reason: "Codex turn was interrupted.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  return undefined;
}

function statusFromServerRequest(method: string, observedAt: string): ObservedStatus {
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
    return {
      value: "needs_attention",
      confidence: "high",
      reason: "Codex requested user input.",
      source: "harness_event",
      updatedAt: observedAt,
      attention: "question",
    };
  }
  return {
    value: "needs_attention",
    confidence: "high",
    reason: "Codex requested approval.",
    source: "harness_event",
    updatedAt: observedAt,
    attention: "tool_approval",
  };
}
