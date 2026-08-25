import { writeFileSync } from "node:fs";
import { z } from "zod";

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

type ClientPhase = (typeof prepareExternalLaunchClientProtocolDiagnosticPhases)[number];
type ServerPhase = (typeof prepareExternalLaunchServerProtocolDiagnosticPhases)[number];
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

process.once("exit", () => {
  if (clientPath !== undefined && clientEvents.length > 0) {
    writeFileSync(clientPath, `${JSON.stringify({ events: clientEvents })}\n`, "utf8");
  }
  if (serverPath !== undefined && serverEvents.length > 0) {
    writeFileSync(serverPath, `${JSON.stringify({ events: serverEvents })}\n`, "utf8");
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
