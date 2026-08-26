import { writeFileSync } from "node:fs";

export const QUICK_SESSION_EVENT_EGRESS_DIAGNOSTIC_PATH_ENV =
  "STATION_QUICK_SESSION_EVENT_EGRESS_DIAGNOSTIC_PATH";

export const quickSessionTargetEventTypes = ["worktree.updated", "session.created"] as const;

export type QuickSessionTargetEventType = (typeof quickSessionTargetEventTypes)[number];

export type QuickSessionEventEgressPhase =
  | "publishEntered"
  | "eventValidated"
  | "publishCompleted"
  | "protocolIteratorResumed"
  | "envelopeValidated"
  | "serializationStarted"
  | "serializationCompleted"
  | "socketWriteReturned"
  | "socketWriteCallbackCompleted";

export type QuickSessionEventEgressDiagnosticEvent = {
  activityId: number;
  eventType: QuickSessionTargetEventType;
  correlationId: string;
  phase: QuickSessionEventEgressPhase;
  atMs: number;
  epochMs: number;
};

const rawDiagnosticPath = process.env[QUICK_SESSION_EVENT_EGRESS_DIAGNOSTIC_PATH_ENV];
const diagnosticPath = rawDiagnosticPath?.trim() ? rawDiagnosticPath : undefined;
const activityByValue = new WeakMap<object, number>();
const eventTypeByValue = new WeakMap<object, QuickSessionTargetEventType>();
const correlationIdByValue = new WeakMap<object, string>();
const events: QuickSessionEventEgressDiagnosticEvent[] = [];
let nextActivityId = 0;

process.once("exit", () => {
  if (diagnosticPath === undefined || events.length === 0) return;
  writeFileSync(
    diagnosticPath,
    `${JSON.stringify({
      events: events
        .slice()
        .sort((left, right) => left.atMs - right.atMs || left.activityId - right.activityId),
    })}\n`,
    "utf8",
  );
});

/** Begins whole-process weak tracking for later exact-correlation selection. */
export function beginQuickSessionEventEgressDiagnostic(
  event: object,
  eventType: string,
  correlationId: string,
): void {
  if (diagnosticPath === undefined || !isQuickSessionTargetEventType(eventType)) return;
  const activityId = ++nextActivityId;
  activityByValue.set(event, activityId);
  eventTypeByValue.set(event, eventType);
  correlationIdByValue.set(event, correlationId);
  record(activityId, eventType, correlationId, "publishEntered");
}

/** Propagates weak identity across strict event validation's new object. */
export function validateQuickSessionEventEgressDiagnostic(source: object, validated: object): void {
  propagateIdentity(source, validated, "eventValidated");
}

/** Propagates weak identity from a validated Station event to its strict envelope. */
export function validateQuickSessionEventEgressEnvelopeDiagnostic(
  event: object,
  envelope: object,
): void {
  propagateIdentity(event, envelope, "envelopeValidated");
}

/** Records an existing phase for a weakly tracked event or envelope identity. */
export function markQuickSessionEventEgressDiagnostic(
  value: unknown,
  phase: Exclude<
    QuickSessionEventEgressPhase,
    "publishEntered" | "eventValidated" | "envelopeValidated"
  >,
): boolean {
  if (!(value instanceof Object)) return false;
  const activityId = activityByValue.get(value);
  const eventType = eventTypeByValue.get(value);
  const correlationId = correlationIdByValue.get(value);
  if (activityId === undefined || eventType === undefined || correlationId === undefined) {
    return false;
  }
  record(activityId, eventType, correlationId, phase);
  return true;
}

function propagateIdentity(
  source: object,
  target: object,
  phase: "eventValidated" | "envelopeValidated",
): void {
  const activityId = activityByValue.get(source);
  const eventType = eventTypeByValue.get(source);
  const correlationId = correlationIdByValue.get(source);
  if (activityId === undefined || eventType === undefined || correlationId === undefined) return;
  activityByValue.set(target, activityId);
  eventTypeByValue.set(target, eventType);
  correlationIdByValue.set(target, correlationId);
  record(activityId, eventType, correlationId, phase);
}

function record(
  activityId: number,
  eventType: QuickSessionTargetEventType,
  correlationId: string,
  phase: QuickSessionEventEgressPhase,
): void {
  const atMs = performance.now();
  events.push({
    activityId,
    eventType,
    correlationId,
    phase,
    atMs,
    epochMs: performance.timeOrigin + atMs,
  });
}

function isQuickSessionTargetEventType(value: string): value is QuickSessionTargetEventType {
  return quickSessionTargetEventTypes.some((eventType) => eventType === value);
}
