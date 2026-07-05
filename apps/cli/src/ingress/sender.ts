import { randomUUID } from "node:crypto";
import { isClaudeForwardedEventType } from "@station/claude";
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
  parseProviderHookEventName,
  parseStationHookIdentityPayload,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import { componentLogPath, createJsonlLogger, type JsonlLogger } from "@station/observability";
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
import { z } from "zod";
import { deliverProviderHookWithSpooling, type ProviderDeliveryAttempt } from "./deliveryPolicy.js";
import type { ProviderHookObserverStartupDeps } from "./observerStartup.js";
import { writeProviderHookSpoolRecord } from "./spool.js";

export type ProviderHookSenderOptions = {
  paths: ObserverPaths;
  configPath?: string;
  observerEntryPath?: string;
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
    deliver: () =>
      attemptHookDelivery(
        input.paths,
        event,
        input.deliveryTimeoutMs ?? defaultDeliveryTimeoutMs,
        deps,
      ),
    spoolReceipt: (error) => spool(input.paths, event, error, deps),
    recordReceipt: ({ paths, event, payloadSummary, receipt }) =>
      logAndReturn(paths, event, receipt, payloadSummary, deps),
  };
  if (input.configPath !== undefined) {
    deliveryInput.configPath = input.configPath;
  }
  if (input.observerEntryPath !== undefined) {
    deliveryInput.observerEntryPath = input.observerEntryPath;
  }
  return deliverProviderHookWithSpooling(deliveryInput);
}

export async function sendClaudeHookPayload(
  input: SendClaudeHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  const eventName = parseProviderHookEventName(enrichedPayload) ?? "unknown";
  if (
    !hasStationOwnership(enrichedPayload) &&
    !hasCorrelatableCwd(enrichedPayload, input.projectRoots)
  ) {
    return ignoredProviderHookReceipt({
      provider: "claude",
      event: eventName,
      clock,
      hookId: deps.hookId,
    });
  }
  // Claude installs only rule-derived hook events, but a fallback global install can
  // surface user-added events; unlisted event types are dropped, never errors.
  // Writer-side filter only saves spool noise — the claude adapter re-enforces it
  // observer-side, where all normalization now runs.
  if (!isClaudeForwardedEventType(eventName)) {
    return ignoredProviderHookReceipt({
      provider: "claude",
      event: eventName,
      clock,
      hookId: deps.hookId,
    });
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

export async function sendCodexHookPayload(
  input: SendCodexHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  const eventName = parseProviderHookEventName(enrichedPayload) ?? "unknown";
  if (
    !hasStationOwnership(enrichedPayload) &&
    !hasCorrelatableCwd(enrichedPayload, input.projectRoots)
  ) {
    return ignoredProviderHookReceipt({
      provider: "codex",
      event: eventName,
      clock,
      hookId: deps.hookId,
    });
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

export async function sendCursorHookPayload(
  input: SendCursorHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  const eventName = parseProviderHookEventName(enrichedPayload) ?? "unknown";
  if (!hasStationOwnership(enrichedPayload)) {
    return ignoredProviderHookReceipt({
      provider: "cursor",
      event: eventName,
      clock,
      hookId: deps.hookId,
    });
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

export async function sendPiHookPayload(
  input: SendPiHookInput,
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const clock = deps.clock ?? systemClock;
  const enrichedPayload = enrichStationHookIdentityPayload({
    payload: input.payload,
    env: input.env ?? process.env,
  });
  if (!hasStationOwnership(enrichedPayload)) {
    return ignoredProviderHookReceipt({
      provider: "pi",
      event: input.eventType,
      clock,
      hookId: deps.hookId,
    });
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

async function attemptHookDelivery(
  paths: ObserverPaths,
  event: ProviderHookEvent,
  timeoutMs: number,
  deps: ProviderHookSenderDeps,
): Promise<ProviderDeliveryAttempt> {
  const delivery = await deliverHook(paths, event, timeoutMs, deps);
  if (delivery.ok && delivery.value.status === "ingested") {
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
      const client = observerClient(paths.socketPath, timeoutMs, deps);
      const receipt = await client.ingestProviderHookEvent(event);
      if (receipt.status !== "ingested") {
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
const hookCwdProbeSchema = z.object({ cwd: z.string().min(1) }).loose();

function hasCorrelatableCwd(
  payload: unknown,
  projectRoots: readonly string[] | undefined,
): boolean {
  const parsed = hookCwdProbeSchema.safeParse(payload);
  if (!parsed.success) {
    return false;
  }
  // No configured roots (config absent): keep the permissive fallback rather
  // than dropping everything.
  if (projectRoots === undefined) {
    return true;
  }
  return projectRoots.some((root) => pathIsSameOrInside(parsed.data.cwd, root));
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
  deps: ProviderHookSenderDeps,
): ReturnType<typeof createObserverClient> {
  return (
    deps.clientFactory?.(socketPath, { timeoutMs }) ??
    createObserverClient({ socketPath, timeoutMs })
  );
}
