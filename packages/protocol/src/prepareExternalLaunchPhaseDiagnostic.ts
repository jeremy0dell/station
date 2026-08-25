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
  "prepareResponseCompleted",
  "boundaryTaskCompleted",
  "protocolCompleted",
] as const;

export const prepareExternalLaunchServerProtocolDiagnosticPhases = [
  "prepareRequestParsed",
  "prepareHandlerStarted",
  "prepareUseCaseDispatchStarted",
  "prepareUseCaseDispatchCompleted",
  "prepareHandlerCompleted",
  "prepareResponseSent",
] as const;

type ClientPhase = (typeof prepareExternalLaunchClientProtocolDiagnosticPhases)[number];
type ServerPhase = (typeof prepareExternalLaunchServerProtocolDiagnosticPhases)[number];
type DiagnosticEvent<TPhase extends string> = { phase: TPhase; atMs: number };

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
 * Records protocol diagnostics in memory; only the process owning nonempty
 * events writes its strict artifact during normal process exit.
 */
export function markPrepareExternalLaunchClientProtocolPhase(phase: ClientPhase): void {
  if (clientPath !== undefined) {
    clientEvents.push({ phase, atMs: performance.now() });
  }
}

export function markPrepareExternalLaunchServerProtocolPhase(phase: ServerPhase): void {
  if (serverPath !== undefined) {
    serverEvents.push({ phase, atMs: performance.now() });
  }
}
