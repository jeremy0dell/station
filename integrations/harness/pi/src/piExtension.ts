import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEventReport } from "@station/contracts";
import { systemClock, toIsoTimestamp } from "@station/runtime";
import { parsePiCompactEvent } from "./event/compactEvent.js";
import { compactPiHookPayload } from "./event/compaction.js";
import { piHookPayloadToHarnessEventReport } from "./event/mapping.js";
import {
  type PiNativeEventName,
  type PiSupportedEventName,
  piNativeEventNames,
} from "./event/names.js";

type PiExtensionApi = {
  on: (
    event: PiNativeEventName,
    handler: (event: unknown, context: unknown) => Promise<void>,
  ) => void;
  events?: {
    on: (channel: string, handler: (data: unknown) => void) => (() => void) | undefined;
  };
};

type PiEventMetadata = {
  activeQuestionCallId?: string;
};

type PiQuestionCall = {
  state: "started" | "open";
  context: unknown;
};

type HookCommandInput = {
  eventType: PiSupportedEventName;
  payload: Record<string, unknown>;
  report: HarnessEventReport;
};

type HookIngressInput = Omit<HookCommandInput, "report">;

export type PiExtensionDeps = {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => Date;
  sendReport?: (input: HookCommandInput) => Promise<void>;
  reportId?: () => string;
  /** Test seam; production ingress child lifetime is always bounded by the default. */
  ingressTimeoutMs?: number;
};

const defaultReportId = () => `hook_${Date.now()}_${randomUUID()}`;
const defaultIngressTimeoutMs = 5000;
const stationPiExtensionProtocol = 2;
const askUserQuestionToolName = "ask_user_question";
const askUserPromptChannel = "rpiv:ask-user:prompt";

/**
 * ADAPTER
 *
 * Compacts allowlisted Pi status events without user-content bodies, derives the
 * stable question-open edge, and serializes delivery to build-aware CLI ingress.
 */
export function registerStationPiExtension(pi: PiExtensionApi, deps: PiExtensionDeps = {}): void {
  const deliver = createSerializedDelivery(deps);
  const questionCalls = new Map<string, PiQuestionCall>();

  for (const eventType of piNativeEventNames) {
    pi.on(eventType, async (event, context) => {
      const metadata = metadataForPiEvent(eventType, event, context, questionCalls);
      await deliver(eventType, event, context, metadata);
    });
  }

  pi.events?.on(askUserPromptChannel, () => {
    const pending = firstQuestionCall(questionCalls, "started");
    if (pending === undefined) return;
    pending.call.state = "open";
    void deliver(
      "question_prompt_open",
      { toolCallId: pending.id, toolName: askUserQuestionToolName },
      pending.call.context,
    );
  });
}

function createSerializedDelivery(deps: PiExtensionDeps) {
  const sendIngress = defaultSendReport(deps);
  let tail = Promise.resolve();

  return (
    eventType: PiSupportedEventName,
    event: unknown,
    context: unknown,
    metadata: PiEventMetadata = {},
  ): Promise<void> => {
    // Custom event-bus callbacks are synchronous, so one queue preserves their order with awaited Pi events.
    tail = tail.then(async () => {
      try {
        const payload = compactPiExtensionEvent(eventType, event, context, deps, metadata);
        if (deps.sendReport === undefined) {
          await sendIngress({ eventType, payload });
          return;
        }
        const report = reportFromPiExtensionPayload(eventType, payload, deps);
        await deps.sendReport({ eventType, payload, report });
      } catch {
        // Extension telemetry must never interrupt the user's Pi session.
      }
    });
    return tail;
  };
}

function metadataForPiEvent(
  eventType: PiNativeEventName,
  event: unknown,
  context: unknown,
  questionCalls: Map<string, PiQuestionCall>,
): PiEventMetadata {
  const eventRecord = asRecord(event);
  if (eventType === "tool_execution_start") {
    const toolCallId = stringField(eventRecord, "toolCallId");
    if (
      stringField(eventRecord, "toolName") === askUserQuestionToolName &&
      toolCallId !== undefined
    ) {
      questionCalls.set(toolCallId, { state: "started", context });
    }
  } else if (eventType === "tool_execution_end") {
    if (stringField(eventRecord, "toolName") === askUserQuestionToolName) {
      removeQuestionCall(questionCalls, stringField(eventRecord, "toolCallId"));
    }
  } else if (eventType === "session_shutdown") {
    questionCalls.clear();
  }

  const activeQuestion = firstQuestionCall(questionCalls, "open");
  return activeQuestion === undefined ? {} : { activeQuestionCallId: activeQuestion.id };
}

function firstQuestionCall(
  questionCalls: Map<string, PiQuestionCall>,
  state: PiQuestionCall["state"],
): { id: string; call: PiQuestionCall } | undefined {
  for (const [id, call] of questionCalls) {
    if (call.state === state) return { id, call };
  }
  return undefined;
}

function removeQuestionCall(
  questionCalls: Map<string, PiQuestionCall>,
  toolCallId: string | undefined,
): void {
  if (toolCallId !== undefined) {
    questionCalls.delete(toolCallId);
    return;
  }
  const first =
    firstQuestionCall(questionCalls, "open") ?? firstQuestionCall(questionCalls, "started");
  if (first !== undefined) questionCalls.delete(first.id);
}

export default function stationPiExtension(pi: PiExtensionApi): void {
  registerStationPiExtension(pi);
}

/**
 * Retains only correlation and low-cardinality lifecycle metadata from one Pi
 * extension event.
 */
export function compactPiExtensionEvent(
  eventType: PiSupportedEventName,
  event: unknown,
  context: unknown,
  deps: PiExtensionDeps = {},
  metadata: PiEventMetadata = {},
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
    station_extension_protocol: stationPiExtensionProtocol,
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
  assignPiEventFields(payload, eventType, eventRecord, metadata);

  parsePiCompactEvent(payload);
  return payload;
}

function assignPiEventFields(
  payload: Record<string, unknown>,
  eventType: PiSupportedEventName,
  event: Record<string, unknown> | undefined,
  metadata: PiEventMetadata,
): void {
  switch (eventType) {
    case "session_start":
      assignOptionalField(payload, "reason", stringField(event, "reason"));
      assignOptionalField(
        payload,
        "previous_session_file",
        stringField(event, "previousSessionFile"),
      );
      return;
    case "session_shutdown":
      assignOptionalField(payload, "reason", stringField(event, "reason"));
      assignOptionalField(payload, "target_session_file", stringField(event, "targetSessionFile"));
      return;
    case "agent_end": {
      const messages = arrayField(event, "messages");
      if (messages !== undefined) payload.message_count = messages.length;
      return;
    }
    case "turn_start":
      assignOptionalField(payload, "turn_index", numberField(event, "turnIndex"));
      return;
    case "tool_execution_start":
      assignOptionalField(payload, "tool_call_id", stringField(event, "toolCallId"));
      assignOptionalField(payload, "tool_name", stringField(event, "toolName"));
      assignOptionalField(payload, "active_question_call_id", metadata.activeQuestionCallId);
      return;
    case "tool_execution_end":
      assignOptionalField(payload, "tool_call_id", stringField(event, "toolCallId"));
      assignOptionalField(payload, "tool_name", stringField(event, "toolName"));
      assignOptionalField(payload, "is_error", booleanField(event, "isError"));
      assignOptionalField(payload, "active_question_call_id", metadata.activeQuestionCallId);
      return;
    case "question_prompt_open":
      assignOptionalField(payload, "tool_call_id", stringField(event, "toolCallId"));
      assignOptionalField(payload, "tool_name", stringField(event, "toolName"));
      return;
    case "message_end": {
      const message = asRecord(event?.message);
      assignOptionalField(payload, "message_role", stringField(message, "role"));
      return;
    }
    case "session_compact": {
      assignOptionalField(payload, "reason", stringField(event, "reason"));
      assignOptionalField(payload, "will_retry", booleanField(event, "willRetry"));
      assignOptionalField(payload, "from_extension", booleanField(event, "fromExtension"));
      const compactionEntry = asRecord(event?.compactionEntry);
      assignOptionalField(payload, "compaction_entry_id", stringField(compactionEntry, "id"));
      return;
    }
    case "agent_start":
    case "agent_settled":
      return;
    default:
      assertNeverPiEvent(eventType);
  }
}

function assertNeverPiEvent(eventType: never): never {
  throw new Error(`Unsupported Pi extension event: ${String(eventType)}.`);
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

function defaultSendReport(deps: PiExtensionDeps): (input: HookIngressInput) => Promise<void> {
  return async (input) => {
    const env = deps.env ?? process.env;
    const timeoutMs = Math.max(
      1,
      Math.min(deps.ingressTimeoutMs ?? defaultIngressTimeoutMs, defaultIngressTimeoutMs),
    );
    const child = spawn(ingressCommand(env), ingressArgs(env, input.eventType), {
      env,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    await writeIngressPayload(child, input.payload);
  };
}

function ingressCommand(env: NodeJS.ProcessEnv): string {
  return env.STATION_INGRESS_BIN?.trim() || "stn-ingress";
}

function ingressArgs(env: NodeJS.ProcessEnv, eventType: string): string[] {
  const args: string[] = [];
  appendIngressPath(args, "--socket", env.STATION_OBSERVER_SOCKET_PATH);
  appendIngressPath(args, "--state-dir", env.STATION_OBSERVER_STATE_DIR);
  appendIngressPath(args, "--spool-dir", env.STATION_HOOK_SPOOL_DIR);
  appendIngressPath(args, "--config", env.STATION_CONFIG_PATH);
  args.push("pi", eventType);
  return args;
}

function appendIngressPath(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    args.push(flag, value);
  }
}

function writeIngressPayload(child: ReturnType<typeof spawn>, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdin = child.stdin;
    if (stdin === null) {
      reject(new Error("stn-ingress stdin was not available."));
      return;
    }
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = (error: unknown) => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already be gone; settling the provider callback still wins.
      }
      settle(error);
    };
    child.once("error", abort);
    stdin.once("error", abort);
    child.once("close", (code) => {
      settle(
        code === 0 ? undefined : new Error(`stn-ingress exited with code ${code ?? "unknown"}.`),
      );
    });
    stdin.end(JSON.stringify(payload));
  });
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
