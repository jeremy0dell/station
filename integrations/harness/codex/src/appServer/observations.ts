import type { HarnessEventObservation } from "@station/contracts";
import { parseCodexAppServerEvent } from "./parse.js";
import { statusFromCodexAppServerEvent } from "./status.js";
import type { CodexAppServerEvent, CodexAppServerObservationContext } from "./types.js";

export function codexAppServerEventToHarnessEventObservation(
  input: unknown,
  context: CodexAppServerObservationContext,
): HarnessEventObservation[] {
  const event = parseCodexAppServerEvent(input);
  if (event.kind === "unsupported") {
    return [];
  }

  const status = statusFromCodexAppServerEvent(event, context.observedAt);
  if (status === undefined) {
    return [];
  }
  const providerData = providerDataFromCodexAppServerEvent(event);
  const observation: HarnessEventObservation = {
    provider: "codex",
    rawEventType: event.method,
    observedAt: context.observedAt,
    status,
    providerData,
  };
  if (context.projectId !== undefined) {
    observation.projectId = context.projectId;
  }
  if (context.worktreeId !== undefined) {
    observation.worktreeId = context.worktreeId;
  }
  if (context.sessionId !== undefined) {
    observation.sessionId = context.sessionId;
  }
  if (context.cwd !== undefined) {
    observation.cwd = context.cwd;
  }
  const threadId = threadIdFromCodexAppServerEvent(event);
  if (threadId !== undefined) {
    observation.nativeSessionId = threadId;
    observation.harnessRunId = context.harnessRunId ?? `codex:app-server:${threadId}`;
  } else if (context.harnessRunId !== undefined) {
    observation.harnessRunId = context.harnessRunId;
  }
  return [observation];
}

function providerDataFromCodexAppServerEvent(
  event: Exclude<CodexAppServerEvent, { kind: "unsupported" }>,
): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    transport: "app-server",
    appServerMethod: event.method,
  };
  const threadId = threadIdFromCodexAppServerEvent(event);
  if (threadId !== undefined) {
    providerData.codexThreadId = threadId;
  }
  if ("turnId" in event) {
    providerData.codexTurnId = event.turnId;
  }
  if ("itemId" in event) {
    providerData.codexItemId = event.itemId;
  }
  if ("requestId" in event && event.requestId !== undefined) {
    providerData.requestId = event.requestId;
  }
  if (event.kind === "thread-status-changed") {
    providerData.threadStatusType = event.threadStatusType;
    providerData.activeFlags = event.activeFlags;
  }
  if (event.kind === "turn-started" || event.kind === "turn-completed") {
    providerData.turnStatus = event.turnStatus;
  }
  if (event.kind === "item-completed") {
    providerData.itemType = event.itemType;
  }
  if (event.kind === "turn-plan-updated") {
    providerData.planStepCount = event.planStepCount;
    providerData.completedPlanStepCount = event.completedPlanStepCount;
  }
  return providerData;
}

function threadIdFromCodexAppServerEvent(event: CodexAppServerEvent): string | undefined {
  if ("threadId" in event) {
    return event.threadId;
  }
  return undefined;
}
