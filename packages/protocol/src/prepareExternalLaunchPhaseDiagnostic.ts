import { writeFileSync } from "node:fs";
import { z } from "zod";

export const IDLE_RESPONSE_DELIVERY_REQUEST_ID_PREFIX = "req_bench_047_idle_";
export const RENDERER_OCCUPANCY_DIAGNOSTIC_ENV =
  "STATION_QUICK_SESSION_RENDERER_OCCUPANCY_DIAGNOSTIC";

export const prepareExternalLaunchClientProtocolDiagnosticPhases = [
  "protocolEntered",
  "boundaryTaskEntered",
  "socketConnectStarted",
  "socketConnected",
  "expectedObserverHealthStarted",
  "expectedObserverHealthCompleted",
  "prepareRequestStarted",
  "responseDeliveryDiagnosticArmed",
  "prepareRequestConstructed",
  "prepareRequestSent",
  "responseIteratorWaitStarted",
  "responseSocketDataCallbackEntered",
  "responseFrameExtracted",
  "responseJsonParsed",
  "responseQueued",
  "responseWaiterResolutionStarted",
  "responseWaiterResolutionCompleted",
  "responseIteratorWaitResumed",
  "responseDequeued",
  "responseYieldStarted",
  "prepareResponseFrameReceived",
  "prepareResponseEnvelopeParsed",
  "prepareResponseCompleted",
  "boundaryTaskCompleted",
  "protocolCompleted",
] as const;

export const prepareExternalLaunchServerProtocolDiagnosticPhases = [
  "expectedObserverHealthRequestParsed",
  "expectedObserverHealthResponseSent",
  "prepareRequestParsed",
  "prepareHandlerStarted",
  "prepareUseCaseDispatchStarted",
  "prepareUseCaseDispatchCompleted",
  "prepareHandlerCompleted",
  "prepareResponseConstructed",
  "prepareResponseSent",
] as const;

export const idleResponseDeliveryClientProtocolDiagnosticPhases = [
  "protocolEntered",
  "boundaryTaskEntered",
  "socketConnectStarted",
  "socketConnected",
  "requestStarted",
  "responseDeliveryDiagnosticArmed",
  "requestConstructed",
  "requestSent",
  "responseIteratorWaitStarted",
  "responseSocketDataCallbackEntered",
  "responseFrameExtracted",
  "responseJsonParsed",
  "responseQueued",
  "responseWaiterResolutionStarted",
  "responseWaiterResolutionCompleted",
  "responseIteratorWaitResumed",
  "responseDequeued",
  "responseYieldStarted",
  "responseFrameReceived",
  "responseEnvelopeParsed",
  "responseValidated",
  "boundaryTaskCompleted",
  "protocolCompleted",
] as const;

export const idleResponseDeliveryServerProtocolDiagnosticPhases = [
  "requestParsed",
  "handlerStarted",
  "handlerCompleted",
  "responseConstructed",
  "responseSent",
] as const;

type ClientPhase = (typeof prepareExternalLaunchClientProtocolDiagnosticPhases)[number];
type ServerPhase = (typeof prepareExternalLaunchServerProtocolDiagnosticPhases)[number];
export type IdleResponseDeliveryClientPhase =
  (typeof idleResponseDeliveryClientProtocolDiagnosticPhases)[number];
export type IdleResponseDeliveryServerPhase =
  (typeof idleResponseDeliveryServerProtocolDiagnosticPhases)[number];
export type ResponseDeliveryDiagnosticScope = "active" | "idle";
export type ResponseDeliveryClientPhase = Extract<IdleResponseDeliveryClientPhase, ClientPhase>;
type DiagnosticEvent<TPhase extends string> = {
  phase: TPhase;
  atMs: number;
  epochMs: number;
};
type DiagnosticTimestamp = Pick<DiagnosticEvent<string>, "atMs" | "epochMs">;
export type RendererOccupancyDiagnosticEvent =
  | (DiagnosticTimestamp & {
      source: "competingSocket";
      phase: "entered" | "completed";
      activityId: number;
    })
  | (DiagnosticTimestamp & {
      source: "clientRuntimeEvent";
      phase: "entered" | "reducerCompleted" | "listenersCompleted" | "hooksCompleted";
      activityId: number;
      eventType: string;
    })
  | (DiagnosticTimestamp & {
      source: "dashboardSource";
      phase: "entered" | "sourceRead" | "projectionCompleted" | "notificationCompleted";
      activityId: number;
    })
  | (DiagnosticTimestamp & {
      source: "rootReact";
      phase: "entered";
      activityId: number;
    })
  | (DiagnosticTimestamp & {
      source: "rootReact";
      phase: "completed";
      activityId: number;
      renderPhase: "mount" | "update" | "nested-update";
      actualDurationMs: number;
      baseDurationMs: number;
      commitAtMs: number;
    })
  | (DiagnosticTimestamp & {
      source: "subscriptionHandoff";
      phase:
        | "frameParsed"
        | "frameQueued"
        | "socketWakeCompleted"
        | "socketCallbackCompleted"
        | "transportIteratorDequeued"
        | "protocolReadResumed"
        | "envelopeParsed";
      activityId: number;
    })
  | (DiagnosticTimestamp & {
      source: "subscriptionHandoff";
      phase:
        | "eventValidated"
        | "subscriptionNextCompleted"
        | "runtimeIteratorResumed"
        | "runtimeEventEntered";
      activityId: number;
      eventType: string;
    })
  | (DiagnosticTimestamp & {
      source: "openTuiFrame";
      phase: "completed";
      activityId: number;
      frameId: number;
    });
export type ExpectedObserverHealthServerProtocolDiagnostic = {
  requestParsed: DiagnosticTimestamp;
  responseSent?: DiagnosticTimestamp;
};

const pathSchema = z.string().min(1);
const clientPathResult = pathSchema.safeParse(
  process.env.STATION_QUICK_SESSION_PROTOCOL_CLIENT_PHASE_DIAGNOSTIC_PATH,
);
const serverPathResult = pathSchema.safeParse(
  process.env.STATION_QUICK_SESSION_PROTOCOL_SERVER_PHASE_DIAGNOSTIC_PATH,
);
const clientPath = clientPathResult.success ? clientPathResult.data : undefined;
const serverPath = serverPathResult.success ? serverPathResult.data : undefined;
const rendererOccupancyEnabled =
  clientPath !== undefined &&
  z.literal("1").safeParse(process.env[RENDERER_OCCUPANCY_DIAGNOSTIC_ENV]).success;
const clientEvents: DiagnosticEvent<ClientPhase>[] = [];
const serverEvents: DiagnosticEvent<ServerPhase>[] = [];
const idleClientEvents: DiagnosticEvent<IdleResponseDeliveryClientPhase>[] = [];
const idleServerEvents: DiagnosticEvent<IdleResponseDeliveryServerPhase>[] = [];
const rendererOccupancyEvents: RendererOccupancyDiagnosticEvent[] = [];
const subscriptionHandoffActivityByValue = new WeakMap<object, number>();
const subscriptionHandoffEventTypeByValue = new WeakMap<object, string>();
let rendererOccupancyWindowOpen = false;
let nextRendererOccupancyActivityId = 0;

process.once("exit", () => {
  if (clientPath !== undefined && (clientEvents.length > 0 || idleClientEvents.length > 0)) {
    const orderedRendererOccupancyEvents = rendererOccupancyEvents
      .slice()
      .sort((left, right) => left.atMs - right.atMs || left.activityId - right.activityId);
    const report = {
      events: clientEvents,
      ...(idleClientEvents.length === 0 ? {} : { idleEvents: idleClientEvents }),
      ...(orderedRendererOccupancyEvents.length === 0
        ? {}
        : { rendererOccupancyEvents: orderedRendererOccupancyEvents }),
    };
    writeFileSync(clientPath, `${JSON.stringify(report)}\n`, "utf8");
  }
  if (serverPath !== undefined && (serverEvents.length > 0 || idleServerEvents.length > 0)) {
    const report = {
      events: serverEvents,
      ...(idleServerEvents.length === 0 ? {} : { idleEvents: idleServerEvents }),
    };
    writeFileSync(serverPath, `${JSON.stringify(report)}\n`, "utf8");
  }
});

/**
 * Records process-local duration and comparable epoch timestamps in memory;
 * only the process owning nonempty events writes during normal process exit.
 */
export function markPrepareExternalLaunchClientProtocolPhase(phase: ClientPhase): void {
  if (clientPath !== undefined) {
    const atMs = performance.now();
    clientEvents.push({ phase, atMs, epochMs: performance.timeOrigin + atMs });
  }
}

export function prepareExternalLaunchClientProtocolDiagnosticEnabled(): boolean {
  return clientPath !== undefined;
}

export function markResponseDeliveryClientProtocolPhase(
  scope: ResponseDeliveryDiagnosticScope,
  phase: ResponseDeliveryClientPhase,
): void {
  if (scope === "active") {
    markPrepareExternalLaunchClientProtocolPhase(phase);
    // No competing work may enter the measured window after its response callback begins.
    if (phase === "responseSocketDataCallbackEntered") {
      rendererOccupancyWindowOpen = false;
    }
    return;
  }
  if (clientPath !== undefined) {
    const atMs = performance.now();
    idleClientEvents.push({ phase, atMs, epochMs: performance.timeOrigin + atMs });
  }
}

/** Opens observation for active-response renderer work without scheduling or delaying it. */
export function armRendererOccupancyDiagnosticWindow(): void {
  if (rendererOccupancyEnabled) {
    rendererOccupancyWindowOpen = true;
  }
}

/** Reports whether the temporary renderer trace is enabled, not whether a request is active. */
export function rendererOccupancyDiagnosticEnabled(): boolean {
  return rendererOccupancyEnabled;
}

/** Begins a synchronous competing socket callback only while the active response is armed. */
export function beginCompetingSocketRendererOccupancy(): number | undefined {
  if (!rendererOccupancyWindowOpen) return undefined;
  const activityId = ++nextRendererOccupancyActivityId;
  rendererOccupancyEvents.push({
    source: "competingSocket",
    phase: "entered",
    activityId,
    ...diagnosticTimestamp(),
  });
  return activityId;
}

export function completeCompetingSocketRendererOccupancy(activityId: number | undefined): void {
  if (activityId === undefined) return;
  rendererOccupancyEvents.push({
    source: "competingSocket",
    phase: "completed",
    activityId,
    ...diagnosticTimestamp(),
  });
}

export function beginClientRuntimeEventRendererOccupancy(eventType: string): number | undefined {
  if (!rendererOccupancyWindowOpen) return undefined;
  const activityId = ++nextRendererOccupancyActivityId;
  rendererOccupancyEvents.push({
    source: "clientRuntimeEvent",
    phase: "entered",
    activityId,
    eventType,
    ...diagnosticTimestamp(),
  });
  return activityId;
}

export function markClientRuntimeEventRendererOccupancy(
  activityId: number | undefined,
  eventType: string,
  phase: "reducerCompleted" | "listenersCompleted" | "hooksCompleted",
): void {
  if (activityId === undefined) return;
  rendererOccupancyEvents.push({
    source: "clientRuntimeEvent",
    phase,
    activityId,
    eventType,
    ...diagnosticTimestamp(),
  });
}

export function beginDashboardSourceRendererOccupancy(): number | undefined {
  if (!rendererOccupancyWindowOpen) return undefined;
  const activityId = ++nextRendererOccupancyActivityId;
  rendererOccupancyEvents.push({
    source: "dashboardSource",
    phase: "entered",
    activityId,
    ...diagnosticTimestamp(),
  });
  return activityId;
}

export function markDashboardSourceRendererOccupancy(
  activityId: number | undefined,
  phase: "sourceRead" | "projectionCompleted" | "notificationCompleted",
): void {
  if (activityId === undefined) return;
  rendererOccupancyEvents.push({
    source: "dashboardSource",
    phase,
    activityId,
    ...diagnosticTimestamp(),
  });
}

export function recordRootReactRendererOccupancy(input: {
  renderPhase: "mount" | "update" | "nested-update";
  actualDurationMs: number;
  baseDurationMs: number;
  startAtMs: number;
  commitAtMs: number;
}): void {
  if (!rendererOccupancyWindowOpen) return;
  const activityId = ++nextRendererOccupancyActivityId;
  rendererOccupancyEvents.push({
    source: "rootReact",
    phase: "entered",
    activityId,
    ...diagnosticTimestamp(input.startAtMs),
  });
  rendererOccupancyEvents.push({
    source: "rootReact",
    phase: "completed",
    activityId,
    renderPhase: input.renderPhase,
    actualDurationMs: input.actualDurationMs,
    baseDurationMs: input.baseDurationMs,
    commitAtMs: input.commitAtMs,
    ...diagnosticTimestamp(),
  });
}

/** Associates one parsed frame by object identity without mutating its protocol payload. */
export function beginSubscriptionHandoffRendererOccupancy(value: unknown): number | undefined {
  if (!rendererOccupancyWindowOpen || !(value instanceof Object)) return undefined;
  const activityId = ++nextRendererOccupancyActivityId;
  subscriptionHandoffActivityByValue.set(value, activityId);
  rendererOccupancyEvents.push({
    source: "subscriptionHandoff",
    phase: "frameParsed",
    activityId,
    ...diagnosticTimestamp(),
  });
  return activityId;
}

export function markSubscriptionHandoffRendererOccupancy(
  value: unknown,
  phase:
    | "frameQueued"
    | "socketWakeCompleted"
    | "socketCallbackCompleted"
    | "transportIteratorDequeued"
    | "protocolReadResumed"
    | "envelopeParsed",
): void {
  if (!(value instanceof Object)) return;
  const activityId = subscriptionHandoffActivityByValue.get(value);
  if (activityId === undefined) return;
  rendererOccupancyEvents.push({
    source: "subscriptionHandoff",
    phase,
    activityId,
    ...diagnosticTimestamp(),
  });
}

/** Propagates the frame's weak diagnostic identity to its validated event object. */
export function validateSubscriptionHandoffRendererOccupancy(
  frame: unknown,
  event: object,
  eventType: string,
): void {
  if (!(frame instanceof Object)) return;
  const activityId = subscriptionHandoffActivityByValue.get(frame);
  if (activityId === undefined) return;
  subscriptionHandoffActivityByValue.set(event, activityId);
  subscriptionHandoffEventTypeByValue.set(event, eventType);
  rendererOccupancyEvents.push({
    source: "subscriptionHandoff",
    phase: "eventValidated",
    activityId,
    eventType,
    ...diagnosticTimestamp(),
  });
}

export function markValidatedSubscriptionHandoffRendererOccupancy(
  event: object,
  phase: "subscriptionNextCompleted" | "runtimeIteratorResumed" | "runtimeEventEntered",
): void {
  const activityId = subscriptionHandoffActivityByValue.get(event);
  const eventType = subscriptionHandoffEventTypeByValue.get(event);
  if (activityId === undefined || eventType === undefined) return;
  rendererOccupancyEvents.push({
    source: "subscriptionHandoff",
    phase,
    activityId,
    eventType,
    ...diagnosticTimestamp(),
  });
}

/** Records OpenTUI's existing synchronous frame-complete event without requesting a render. */
export function recordOpenTuiFrameRendererOccupancy(frameId: number): void {
  if (!rendererOccupancyWindowOpen) return;
  rendererOccupancyEvents.push({
    source: "openTuiFrame",
    phase: "completed",
    activityId: ++nextRendererOccupancyActivityId,
    frameId,
    ...diagnosticTimestamp(),
  });
}

export function markIdleResponseDeliveryClientProtocolPhase(
  phase: IdleResponseDeliveryClientPhase,
): void {
  if (clientPath !== undefined) {
    const atMs = performance.now();
    idleClientEvents.push({ phase, atMs, epochMs: performance.timeOrigin + atMs });
  }
}

export function markIdleResponseDeliveryServerProtocolPhase(
  phase: IdleResponseDeliveryServerPhase,
): void {
  if (serverPath !== undefined) {
    idleServerEvents.push({ phase, ...diagnosticTimestamp() });
  }
}

export function markPrepareExternalLaunchServerProtocolPhase(phase: ServerPhase): void {
  if (serverPath !== undefined) {
    serverEvents.push({ phase, ...diagnosticTimestamp() });
  }
}

/** Buffers a same-connection health exchange until a prepare request proves ownership. */
export function beginExpectedObserverHealthServerProtocolDiagnostic():
  | ExpectedObserverHealthServerProtocolDiagnostic
  | undefined {
  return serverPath === undefined ? undefined : { requestParsed: diagnosticTimestamp() };
}

export function completeExpectedObserverHealthServerProtocolDiagnostic(
  diagnostic: ExpectedObserverHealthServerProtocolDiagnostic | undefined,
): void {
  if (diagnostic !== undefined) {
    diagnostic.responseSent = diagnosticTimestamp();
  }
}

export function commitExpectedObserverHealthServerProtocolDiagnostic(
  diagnostic: ExpectedObserverHealthServerProtocolDiagnostic | undefined,
): void {
  if (serverPath !== undefined && diagnostic?.responseSent !== undefined) {
    serverEvents.push({
      phase: "expectedObserverHealthRequestParsed",
      ...diagnostic.requestParsed,
    });
    serverEvents.push({
      phase: "expectedObserverHealthResponseSent",
      ...diagnostic.responseSent,
    });
  }
}

function diagnosticTimestamp(atMs = performance.now()): DiagnosticTimestamp {
  return { atMs, epochMs: performance.timeOrigin + atMs };
}
