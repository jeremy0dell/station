import { randomUUID } from "node:crypto";
import { isClaudeForwardedEventType } from "@station/claude";
import { isCodexForwardedEventType } from "@station/codex";
import type { ObserverPaths } from "@station/config";
import type {
  ProviderHookEvent,
  ProviderHookPayloadSummary,
  ProviderHookReceipt,
  SafeError,
} from "@station/contracts";
import {
  enrichStationHookIdentityPayload,
  ProviderHookEventSchema,
  ProviderHookReceiptSchema,
  parseProviderHookCwd,
  parseProviderHookEventName,
  parseStationHookIdentityPayload,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import { componentLogPath, createJsonlLogger, type JsonlLogger } from "@station/observability";
import { isOpenCodeForwardedEventType } from "@station/opencode";
import { createObserverClient } from "@station/protocol";
import {
  pathIsSameOrInside,
  type RuntimeClock,
  runRuntimeBoundaryWithTimeout,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { normalizeWorktrunkLifecycleEvent } from "@station/worktrunk";
import { deliverProviderHookWithSpooling, type ProviderDeliveryAttempt } from "./deliveryPolicy.js";
import type {
  ProviderHookObserverCommand,
  ProviderHookObserverStartupDeps,
} from "./observerStartup.js";
import { writeProviderHookSpoolRecord } from "./spool.js";

export type ProviderHookSenderOptions = {
  paths: ObserverPaths;
  configPath?: string;
  observerCommand?: ProviderHookObserverCommand;
  autoStart?: boolean;
  deliveryTimeoutMs?: number;
  startupTimeoutMs?: number;
  rateLimitMs?: number;
  /**
   * Roots (project repos + managed-worktree dirs) an env-less session's cwd
   * must fall under to be worth delivering. Undefined keeps the permissive
   * fallback (any cwd); provided (even empty) gates on membership.
   */
  projectRoots?: readonly string[];
};

type ProviderHookClientFactoryOptions = {
  timeoutMs: number;
  /** Exact Observer selector accepted by delivery readiness. */
  expectedBuildVersion?: string;
};

export type ProviderHookSenderDeps = ProviderHookObserverStartupDeps & {
  clientFactory?: (
    socketPath: string,
    options: ProviderHookClientFactoryOptions,
  ) => ReturnType<typeof createObserverClient>;
  clock?: RuntimeClock;
  writeSpool?: typeof writeProviderHookSpoolRecord;
  hookId?: () => string;
  logger?: JsonlLogger;
};

export type SendProviderHookEventInput = ProviderHookSenderOptions & {
  provider: string;
  kind: ProviderHookEvent["kind"];
  event: string;
  payload?: unknown;
};

export type SendClaudeHookInput = ProviderHookSenderOptions & {
  payload: unknown;
  env?: NodeJS.ProcessEnv;
};

export type SendCodexHookInput = ProviderHookSenderOptions & {
  payload: unknown;
  env?: NodeJS.ProcessEnv;
};

export type SendCursorHookInput = ProviderHookSenderOptions & {
  payload: unknown;
  env?: NodeJS.ProcessEnv;
};

export type SendPiHookInput = ProviderHookSenderOptions & {
  eventType: string;
  payload: unknown;
  env?: NodeJS.ProcessEnv;
};

export type SendOpenCodeHookInput = ProviderHookSenderOptions & {
  eventType: string;
  payload: unknown;
  env?: NodeJS.ProcessEnv;
};

const defaultHookId = () => `hook_${Date.now()}_${randomUUID()}`;
const defaultDeliveryTimeoutMs = 2000;

export async function sendWorktrunkHookEvent(
  input: ProviderHookSenderOptions & { event: string; payload?: unknown },
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  return sendProviderHookEvent(
    {
      ...input,
      provider: "worktrunk",
      kind: "worktree",
      event: normalizeWorktrunkLifecycleEvent(input.event),
    },
    deps,
  );
}

/**
 * USE CASE
 *
 * Validates shared provider-hook ingress, pins delivery to the accepted
 * Observer build, and applies the centralized delivery-or-spool policy.
 */
export async function sendProviderHookEvent(
  input: SendProviderHookEventInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const event = ProviderHookEventSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: deps.hookId?.() ?? defaultHookId(),
    provider: input.provider,
    kind: input.kind,
    event: input.event,
    receivedAt: toIsoTimestamp(clock.now()),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
  const payloadSummary = payloadSummaryFor(input.payload);

  const deliveryInput: Parameters<typeof deliverProviderHookWithSpooling>[0] = {
    paths: input.paths,
    event,
    payloadSummary,
    autoStart: input.autoStart ?? true,
    startupTimeoutMs: input.startupTimeoutMs ?? 1500,
    rateLimitMs: input.rateLimitMs ?? 2000,
    deps,
    deliver: (expectedBuildVersion) =>
      attemptHookDelivery(
        input.paths,
        event,
        input.deliveryTimeoutMs ?? defaultDeliveryTimeoutMs,
        expectedBuildVersion,
        deps,
      ),
    spoolReceipt: (error) => spool(input.paths, event, error, deps),
    recordReceipt: ({ paths, event, payloadSummary, receipt }) =>
      logAndReturn(paths, event, receipt, payloadSummary, deps),
  };
  if (input.configPath !== undefined) {
    deliveryInput.configPath = input.configPath;
  }
  if (input.observerCommand !== undefined) {
    deliveryInput.observerCommand = input.observerCommand;
  }
  return deliverProviderHookWithSpooling(deliveryInput);
}

/**
 * ADAPTER
 *
 * Admits Claude's forwarded events before applying Station ownership/cwd
 * correlation and translating hook stdin into shared harness ingress.
 */
export async function sendClaudeHookPayload(
  input: SendClaudeHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const eventName = parseProviderHookEventName(input.payload) ?? "unknown";
  // Admission precedes correlation so unsupported provider events remain zero-work.
  if (!isClaudeForwardedEventType(eventName)) {
    return ignoredProviderHookReceipt({
      provider: "claude",
      event: eventName,
      clock,
      hookId: deps.hookId,
    });
  }
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  const correlationFailure = providerHookCorrelationFailureReason(
    enrichedPayload,
    input.projectRoots,
  );
  if (correlationFailure !== undefined) {
    return ignoredProviderHookCorrelationReceipt(
      input,
      { provider: "claude", event: eventName, reason: correlationFailure },
      deps,
    );
  }

  return sendProviderHookEvent(
    {
      ...input,
      provider: "claude",
      kind: "harness",
      event: eventName,
      payload: enrichedPayload,
    },
    deps,
  );
}

/**
 * ADAPTER
 *
 * Admits Codex's forwarded events before applying Station ownership/cwd
 * correlation and translating hook stdin into shared harness ingress.
 */
export async function sendCodexHookPayload(
  input: SendCodexHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const eventName = parseProviderHookEventName(input.payload) ?? "unknown";
  if (!isCodexForwardedEventType(eventName)) {
    return ignoredProviderHookReceipt({
      provider: "codex",
      event: eventName,
      clock,
      hookId: deps.hookId,
    });
  }
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  const correlationFailure = providerHookCorrelationFailureReason(
    enrichedPayload,
    input.projectRoots,
  );
  if (correlationFailure !== undefined) {
    return ignoredProviderHookCorrelationReceipt(
      input,
      { provider: "codex", event: eventName, reason: correlationFailure },
      deps,
    );
  }

  return sendProviderHookEvent(
    {
      ...input,
      provider: "codex",
      kind: "harness",
      event: eventName,
      payload: enrichedPayload,
    },
    deps,
  );
}

/**
 * ADAPTER
 *
 * Enriches Cursor hook stdin with Station identity and requires complete
 * ownership before translating it into shared harness ingress.
 */
export async function sendCursorHookPayload(
  input: SendCursorHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  const eventName = parseProviderHookEventName(enrichedPayload) ?? "unknown";
  if (!hasStationOwnership(enrichedPayload)) {
    return ignoredProviderHookCorrelationReceipt(
      input,
      { provider: "cursor", event: eventName, reason: "missing-station-ownership" },
      deps,
    );
  }

  return sendProviderHookEvent(
    {
      ...input,
      provider: "cursor",
      kind: "harness",
      event: eventName,
      payload: enrichedPayload,
    },
    deps,
  );
}

/**
 * ADAPTER
 *
 * Translates Pi extension events into shared harness ingress only when their
 * enriched payload carries complete Station ownership.
 */
export async function sendPiHookPayload(
  input: SendPiHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  if (!hasStationOwnership(enrichedPayload)) {
    return ignoredProviderHookCorrelationReceipt(
      input,
      { provider: "pi", event: input.eventType, reason: "missing-station-ownership" },
      deps,
    );
  }

  return sendProviderHookEvent(
    {
      ...input,
      provider: "pi",
      kind: "harness",
      event: input.eventType,
      payload: enrichedPayload,
    },
    deps,
  );
}

/**
 * ADAPTER
 *
 * Applies OpenCode rule admission before requiring complete Station ownership
 * and translating the payload into shared harness ingress.
 */
export async function sendOpenCodeHookPayload(
  input: SendOpenCodeHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  if (!isOpenCodeForwardedEventType(input.eventType)) {
    return ignoredProviderHookReceipt({
      provider: "opencode",
      event: input.eventType,
      clock,
      hookId: deps.hookId,
    });
  }
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  if (!hasStationOwnership(enrichedPayload)) {
    return ignoredProviderHookCorrelationReceipt(
      input,
      {
        provider: "opencode",
        event: input.eventType,
        reason: "missing-station-ownership",
      },
      deps,
    );
  }

  return sendProviderHookEvent(
    {
      ...input,
      provider: "opencode",
      kind: "harness",
      event: input.eventType,
      payload: enrichedPayload,
    },
    deps,
  );
}

async function attemptHookDelivery(
  paths: ObserverPaths,
  event: ProviderHookEvent,
  timeoutMs: number,
  expectedBuildVersion: string,
  deps: ProviderHookSenderDeps,
): Promise<ProviderDeliveryAttempt> {
  const delivery = await deliverHook(paths, event, timeoutMs, expectedBuildVersion, deps);
  if (
    delivery.ok &&
    (delivery.value.status === "ingested" || delivery.value.status === "rejected")
  ) {
    return { receipt: delivery.value };
  }
  if (delivery.ok) {
    const attempt: ProviderDeliveryAttempt = {};
    if (delivery.value.error !== undefined) {
      attempt.error = delivery.value.error;
    }
    return attempt;
  }
  return { error: delivery.error };
}

async function deliverHook(
  paths: ObserverPaths,
  event: ProviderHookEvent,
  timeoutMs: number,
  expectedBuildVersion: string,
  deps: ProviderHookSenderDeps,
) {
  return runRuntimeBoundaryWithTimeout(
    {
      operation: "providerHooks.hook.deliver",
      clock: deps.clock,
      timeoutMs,
      error: {
        tag: "HookDeliveryError",
        code: "HOOK_DELIVERY_FAILED",
        message: "Hook event could not be delivered to the observer.",
        provider: event.provider,
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "HOOK_DELIVERY_TIMEOUT",
        message: "Hook event delivery timed out.",
        provider: event.provider,
      },
    },
    async () => {
      const client = observerClient(paths.socketPath, timeoutMs, expectedBuildVersion, deps);
      const receipt = await client.ingestProviderHookEvent(event);
      if (receipt.status !== "ingested" && receipt.status !== "rejected") {
        throw (
          receipt.error ??
          safeErrorFromUnknown(receipt, {
            tag: "HookDeliveryError",
            code: "HOOK_REJECTED",
            message: "Observer rejected the hook event.",
            provider: event.provider,
          })
        );
      }
      return receipt;
    },
  );
}

async function spool(
  paths: ObserverPaths,
  event: ProviderHookEvent,
  error: SafeError | undefined,
  deps: ProviderHookSenderDeps,
): Promise<ProviderHookReceipt> {
  return (deps.writeSpool ?? writeProviderHookSpoolRecord)({
    spoolDir: paths.hookSpoolDir,
    event,
    ...(error === undefined ? {} : { error }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  });
}

async function logAndReturn(
  paths: ObserverPaths,
  event: ProviderHookEvent,
  receipt: ProviderHookReceipt,
  payloadSummary: ProviderHookPayloadSummary,
  deps: ProviderHookSenderDeps,
): Promise<ProviderHookReceipt> {
  const logger =
    deps.logger ??
    createJsonlLogger({
      component: "hook",
      path: componentLogPath(paths.stateDir, "hook"),
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    });
  try {
    const level =
      receipt.status === "ingested" ? "info" : receipt.status === "spooled" ? "warn" : "error";
    await logger.log({
      level,
      message:
        receipt.status === "ingested"
          ? "Provider hook delivered to observer."
          : receipt.status === "spooled"
            ? "Provider hook spooled for later delivery."
            : "Provider hook rejected.",
      provider: event.provider,
      attributes: {
        hookId: receipt.hookId,
        status: receipt.status,
        event: event.event,
        kind: event.kind,
        payloadSummary,
        ...(receipt.error === undefined ? {} : { error: receipt.error }),
      },
    });
  } catch {
    // Hook logging must never block provider hook completion.
  }
  return receipt;
}

function ignoredProviderHookReceipt(input: {
  provider: string;
  event: string;
  clock: RuntimeClock;
  hookId?: (() => string) | undefined;
}): ProviderHookReceipt {
  return ProviderHookReceiptSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: input.hookId?.() ?? defaultHookId(),
    provider: input.provider,
    event: input.event,
    accepted: false,
    status: "ignored",
    receivedAt: toIsoTimestamp(input.clock.now()),
  });
}

type CorrelatedHookProvider = "claude" | "codex" | "cursor" | "pi" | "opencode";

type ProviderHookCorrelationFailureReason =
  | "missing-station-ownership"
  | "cwd-outside-configured-roots";

type ProviderHookCorrelationFailure = {
  provider: CorrelatedHookProvider;
  event: string;
  reason: ProviderHookCorrelationFailureReason;
};

const providerHookCorrelationFailureMessages: Record<ProviderHookCorrelationFailureReason, string> =
  {
    "missing-station-ownership":
      "Provider hook ignored before Observer delivery because Station ownership was missing.",
    "cwd-outside-configured-roots":
      "Provider hook ignored before Observer delivery because cwd did not match a configured Station project/worktree root.",
  };

async function ignoredProviderHookCorrelationReceipt(
  options: Pick<ProviderHookSenderOptions, "paths">,
  failure: ProviderHookCorrelationFailure,
  deps: ProviderHookSenderDeps,
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const receipt = ignoredProviderHookReceipt({
    provider: failure.provider,
    event: failure.event,
    clock,
    hookId: deps.hookId,
  });
  try {
    const logger =
      deps.logger ??
      createJsonlLogger({
        component: "hook",
        path: componentLogPath(options.paths.stateDir, "hook"),
        clock,
      });
    await logger.log({
      level: "info",
      message: providerHookCorrelationFailureMessages[failure.reason],
      provider: failure.provider,
      attributes: {
        hookId: receipt.hookId,
        status: receipt.status,
        reason: failure.reason,
      },
    });
  } catch {
    // Correlation evidence is best-effort and cannot change hook completion semantics.
  }
  return receipt;
}

function payloadSummaryFor(payload: unknown): ProviderHookPayloadSummary {
  if (payload === undefined) {
    return {
      present: false,
      originalBytes: null,
      compactedBytes: null,
      compacted: false,
      omittedFieldNames: [],
    };
  }
  const bytes = jsonByteCount(payload);
  return {
    present: true,
    originalBytes: bytes,
    compactedBytes: bytes,
    compacted: false,
    omittedFieldNames: [],
  };
}

// External sessions (no station env) are deliverable when the payload cwd falls
// under a configured project/worktree root — an unrelated dir would never
// correlate at the observer, so delivering (and spooling) its events is waste.
// Pre-parse probe only; full event schemas validate at the adapter boundary.
function providerHookCorrelationFailureReason(
  payload: unknown,
  projectRoots: readonly string[] | undefined,
): ProviderHookCorrelationFailureReason | undefined {
  if (hasStationOwnership(payload)) {
    return undefined;
  }
  const cwd = parseProviderHookCwd(payload);
  if (cwd === undefined) {
    return "missing-station-ownership";
  }
  // An absent config preserves external-session cwd correlation, while an
  // explicitly empty root set rejects every cwd.
  if (projectRoots === undefined) {
    return undefined;
  }
  return projectRoots.some((root) => pathIsSameOrInside(cwd, root))
    ? undefined
    : "cwd-outside-configured-roots";
}

function hasStationOwnership(payload: unknown): boolean {
  const identity = parseStationHookIdentityPayload(payload);
  return identity?.station_session_id !== undefined && identity.station_worktree_id !== undefined;
}

function jsonByteCount(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

function observerClient(
  socketPath: string,
  timeoutMs: number,
  expectedBuildVersion: string,
  deps: ProviderHookSenderDeps,
): ReturnType<typeof createObserverClient> {
  return (
    deps.clientFactory?.(socketPath, { timeoutMs, expectedBuildVersion }) ??
    createObserverClient({ socketPath, timeoutMs, expectedBuildVersion })
  );
}
