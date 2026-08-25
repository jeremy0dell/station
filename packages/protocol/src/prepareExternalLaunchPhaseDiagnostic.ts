import { writeFileSync } from "node:fs";
import { z } from "zod";

export const IDLE_RESPONSE_DELIVERY_REQUEST_ID_PREFIX = "req_bench_047_idle_";

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
const clientEvents: DiagnosticEvent<ClientPhase>[] = [];
const serverEvents: DiagnosticEvent<ServerPhase>[] = [];
const idleClientEvents: DiagnosticEvent<IdleResponseDeliveryClientPhase>[] = [];
const idleServerEvents: DiagnosticEvent<IdleResponseDeliveryServerPhase>[] = [];

process.once("exit", () => {
  if (clientPath !== undefined && (clientEvents.length > 0 || idleClientEvents.length > 0)) {
    const report = {
      events: clientEvents,
      ...(idleClientEvents.length === 0 ? {} : { idleEvents: idleClientEvents }),
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
    return;
  }
  if (clientPath !== undefined) {
    const atMs = performance.now();
    idleClientEvents.push({ phase, atMs, epochMs: performance.timeOrigin + atMs });
  }
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

function diagnosticTimestamp(): DiagnosticTimestamp {
  const atMs = performance.now();
  return { atMs, epochMs: performance.timeOrigin + atMs };
}
