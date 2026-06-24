import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEventReport, HarnessEventReportReceipt, SafeError } from "@station/contracts";
import { HarnessEventReportSpoolRecordSchema, STATION_SCHEMA_VERSION } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { safeErrorFromUnknown, systemClock, toIsoTimestamp } from "@station/runtime";
import { parsePiCompactEvent } from "./event/compactEvent.js";
import { compactPiHookPayload } from "./event/compaction.js";
import { piHookPayloadToHarnessEventReport } from "./event/mapping.js";
import { type PiSupportedEventName, piSupportedEventNames } from "./event/names.js";

type PiExtensionApi = {
  on: (
    event: PiSupportedEventName,
    handler: (event: unknown, context: unknown) => Promise<void>,
  ) => void;
};

type HookCommandInput = {
  eventType: PiSupportedEventName;
  payload: Record<string, unknown>;
  report: HarnessEventReport;
};

export type PiExtensionDeps = {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => Date;
  sendReport?: (input: HookCommandInput) => Promise<void>;
  reportId?: () => string;
};

const defaultReportId = () => `hook_${Date.now()}_${randomUUID()}`;

export function registerStationPiExtension(pi: PiExtensionApi, deps: PiExtensionDeps = {}): void {
  for (const eventType of piSupportedEventNames) {
    pi.on(eventType, async (event, context) => {
      try {
        const payload = compactPiExtensionEvent(eventType, event, context, deps);
        const report = reportFromPiExtensionPayload(eventType, payload, deps);
        await (deps.sendReport ?? defaultSendReport(deps))({ eventType, payload, report });
      } catch {
        // Extension telemetry must never interrupt the user's Pi session.
      }
    });
  }
}

export default function stationPiExtension(pi: PiExtensionApi): void {
  registerStationPiExtension(pi);
}

export function compactPiExtensionEvent(
  eventType: PiSupportedEventName,
  event: unknown,
  context: unknown,
  deps: PiExtensionDeps = {},
): Record<string, unknown> {
  const env = deps.env ?? process.env;
  const eventRecord = asRecord(event);
  const contextRecord = asRecord(context);
  const sessionManager = asRecord(contextRecord?.sessionManager);
  const sessionFile = stringFromFunction(sessionManager, "getSessionFile");
  const cwd =
    stringField(contextRecord, "cwd") ??
    stringField(eventRecord, "cwd") ??
    env.STATION_WORKTREE_PATH ??
    process.cwd();

  const payload: Record<string, unknown> = {
    event_type: eventType,
    cwd,
    pid: deps.pid ?? process.pid,
  };
  assignEnvField(payload, "station_project_id", env.STATION_PROJECT_ID);
  assignEnvField(payload, "station_worktree_id", env.STATION_WORKTREE_ID);
  assignEnvField(payload, "station_worktree_path", env.STATION_WORKTREE_PATH);
  assignEnvField(payload, "station_session_id", env.STATION_SESSION_ID);
  assignEnvField(payload, "station_terminal_provider", env.STATION_TERMINAL_PROVIDER);
  assignEnvField(payload, "station_terminal_target_id", env.STATION_TERMINAL_TARGET_ID);
  assignOptionalField(payload, "pi_session_file", sessionFile);
  assignOptionalField(
    payload,
    "pi_session_id",
    piSessionId(eventRecord, sessionManager, sessionFile),
  );
  assignOptionalField(payload, "model", modelSummary(eventRecord, contextRecord));

  if (eventType === "session_start") {
    assignOptionalField(payload, "reason", stringField(eventRecord, "reason"));
    assignOptionalField(
      payload,
      "previous_session_file",
      stringField(eventRecord, "previousSessionFile"),
    );
  }
  if (eventType === "session_shutdown") {
    assignOptionalField(payload, "reason", stringField(eventRecord, "reason"));
    assignOptionalField(
      payload,
      "target_session_file",
      stringField(eventRecord, "targetSessionFile"),
    );
  }
  if (eventType === "agent_end") {
    const messages = arrayField(eventRecord, "messages");
    if (messages !== undefined) {
      payload.message_count = messages.length;
    }
  }
  if (eventType === "turn_start") {
    assignOptionalField(payload, "turn_index", numberField(eventRecord, "turnIndex"));
  }
  if (eventType === "tool_execution_start" || eventType === "tool_execution_end") {
    assignOptionalField(payload, "tool_call_id", stringField(eventRecord, "toolCallId"));
    assignOptionalField(payload, "tool_name", stringField(eventRecord, "toolName"));
  }
  if (eventType === "tool_execution_end") {
    assignOptionalField(payload, "is_error", booleanField(eventRecord, "isError"));
  }
  if (eventType === "message_end") {
    const message = asRecord(eventRecord?.message);
    assignOptionalField(payload, "message_role", stringField(message, "role"));
  }
  if (eventType === "session_compact") {
    assignOptionalField(payload, "from_extension", booleanField(eventRecord, "fromExtension"));
    const compactionEntry = asRecord(eventRecord?.compactionEntry);
    assignOptionalField(payload, "compaction_entry_id", stringField(compactionEntry, "id"));
  }

  parsePiCompactEvent(payload);
  return payload;
}

function reportFromPiExtensionPayload(
  eventType: PiSupportedEventName,
  payload: Record<string, unknown>,
  deps: PiExtensionDeps,
): HarnessEventReport {
  const observedAt = toIsoTimestamp(deps.now?.() ?? systemClock.now());
  const compaction = compactPiHookPayload(eventType, payload);
  return piHookPayloadToHarnessEventReport({
    reportId: deps.reportId?.() ?? defaultReportId(),
    eventType,
    observedAt,
    payload: compaction.payload,
    diagnostics: {
      payloadBytes: compaction.originalByteCount,
      compactedBytes: compaction.compactedByteCount,
      compacted: compaction.compacted,
      truncated: false,
      omittedFieldNames: compaction.omittedFieldNames,
    },
  });
}

function defaultSendReport(deps: PiExtensionDeps): (input: HookCommandInput) => Promise<void> {
  return async (input) => {
    try {
      const client = createObserverClient({
        socketPath: observerSocketPath(deps.env ?? process.env),
        timeoutMs: 2000,
      });
      const receipt = await client.reportHarnessEvent(input.report);
      if (receipt.status !== "accepted") {
        throw receipt.error ?? new Error(`Observer rejected Pi report ${input.report.reportId}.`);
      }
    } catch (error) {
      await spoolReport(
        input.report,
        safeErrorFromUnknown(error, spoolErrorDefaults(input.report)),
        deps,
      );
    }
  };
}

async function spoolReport(
  report: HarnessEventReport,
  error: SafeError,
  deps: PiExtensionDeps,
): Promise<HarnessEventReportReceipt> {
  const env = deps.env ?? process.env;
  const clock = deps.now?.() ?? systemClock.now();
  const spoolId = `spool_${Date.now()}_${randomUUID()}`;
  const spoolDir = hookSpoolDir(env);
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });
  await chmod(spoolDir, 0o700);
  const record = HarnessEventReportSpoolRecordSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    spoolId,
    createdAt: toIsoTimestamp(clock),
    report,
    attempts: 0,
    lastError: error,
  });
  await writeFile(join(spoolDir, `${spoolId}.json`), JSON.stringify(record, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: report.reportId,
    provider: report.provider,
    eventType: report.eventType,
    accepted: true,
    status: "spooled",
    receivedAt: report.observedAt,
    projected: false,
    scheduledReconcile: false,
    error,
  };
}

function observerSocketPath(env: NodeJS.ProcessEnv): string {
  if (
    env.STATION_OBSERVER_SOCKET_PATH !== undefined &&
    env.STATION_OBSERVER_SOCKET_PATH.length > 0
  ) {
    return env.STATION_OBSERVER_SOCKET_PATH;
  }
  if (env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR.length > 0) {
    return join(env.XDG_RUNTIME_DIR, "station", "observer.sock");
  }
  return join(observerStateDir(env), "run", "observer.sock");
}

function hookSpoolDir(env: NodeJS.ProcessEnv): string {
  if (env.STATION_HOOK_SPOOL_DIR !== undefined && env.STATION_HOOK_SPOOL_DIR.length > 0) {
    return env.STATION_HOOK_SPOOL_DIR;
  }
  return join(observerStateDir(env), "spool", "hooks");
}

function observerStateDir(env: NodeJS.ProcessEnv): string {
  if (env.STATION_OBSERVER_STATE_DIR !== undefined && env.STATION_OBSERVER_STATE_DIR.length > 0) {
    return env.STATION_OBSERVER_STATE_DIR;
  }
  return join(homedir(), ".local", "state", "station");
}

function spoolErrorDefaults(report: HarnessEventReport) {
  return {
    tag: "HookDeliveryError",
    code: "HOOK_REPORT_DELIVERY_FAILED",
    message: "Pi harness event report could not be delivered to the observer.",
    provider: report.provider,
  };
}

function piSessionId(
  event: Record<string, unknown> | undefined,
  sessionManager: Record<string, unknown> | undefined,
  sessionFile: string | undefined,
): string | undefined {
  return (
    stringField(event, "sessionId") ??
    stringField(event, "session_id") ??
    stringFromFunction(sessionManager, "getSessionId") ??
    sessionIdFromFile(sessionFile)
  );
}

function sessionIdFromFile(sessionFile: string | undefined): string | undefined {
  if (sessionFile === undefined) {
    return undefined;
  }
  const name = basename(sessionFile);
  const withoutJsonl = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
  return withoutJsonl.length === 0 ? undefined : withoutJsonl;
}

function modelSummary(
  event: Record<string, unknown> | undefined,
  context: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  const source = asRecord(event?.model) ?? asRecord(context?.model);
  if (source === undefined) {
    return undefined;
  }
  const output: Record<string, string> = {};
  assignStringField(output, "provider", stringField(source, "provider"));
  assignStringField(output, "id", stringField(source, "id"));
  assignStringField(output, "name", stringField(source, "name"));
  return Object.keys(output).length === 0 ? undefined : output;
}

function assignEnvField(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined && value.length > 0) {
    target[key] = value;
  }
}

function assignOptionalField(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function assignStringField(
  target: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function stringFromFunction(
  target: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const fn = target?.[key];
  if (typeof fn !== "function") {
    return undefined;
  }
  try {
    const value = fn.call(target);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function stringField(target: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = target?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(target: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = target?.[key];
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function booleanField(
  target: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = target?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function arrayField(
  target: Record<string, unknown> | undefined,
  key: string,
): unknown[] | undefined {
  const value = target?.[key];
  return Array.isArray(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export const stationPiExtensionPath = fileURLToPath(
  new URL("../dist/piExtension.js", import.meta.url),
);
