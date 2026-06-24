import type { ObservabilityRetentionConfig } from "@station/config";
import type {
  HarnessEventObservation,
  ProviderHookEvent,
  ProviderProjectConfig,
  SafeError,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { TerminalTargetObservationSchema, WorktreeObservationSchema } from "@station/contracts";
import { type RuntimeClock, runRuntimeBoundaryWithTimeout, systemClock } from "@station/runtime";
import type {
  ObserverPersistence,
  PersistedProviderObservation,
  ProviderObservationKind,
  ProviderObservationType,
} from "../persistence/index.js";
import {
  providerObservationExpiresAt,
  providerObservationRetentionDays,
} from "../persistence/retention.js";
import { stripTerminalProviderData } from "../persistence/terminalObservations.js";
import type { ProviderRegistry } from "../providers/registry.js";

export type ProviderHookIngestResult = {
  observations: number;
  error?: SafeError;
};

export type IngestProviderHookEventOptions = {
  event: ProviderHookEvent;
  providers: ProviderRegistry;
  projects: ProviderProjectConfig[];
  persistence: ObserverPersistence;
  clock?: RuntimeClock;
  timeoutMs?: number;
  retention?: ObservabilityRetentionConfig;
};

type ObservationRecord = {
  provider: string;
  providerType: ProviderObservationType;
  entityKind: ProviderObservationKind;
  entityKey: string;
  payload: unknown;
  observedAt: string;
};

export async function ingestProviderHookEvent(
  options: IngestProviderHookEventOptions,
): Promise<ProviderHookIngestResult> {
  const clock = options.clock ?? systemClock;
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: `observer.providerHook.ingest.${options.event.provider}`,
      clock,
      timeoutMs: options.timeoutMs ?? 1000,
      error: {
        tag: "HookProviderIngestError",
        code: "HOOK_PROVIDER_INGEST_FAILED",
        message: "Provider hook ingest failed.",
        provider: options.event.provider,
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "HOOK_PROVIDER_INGEST_TIMEOUT",
        message: "Provider hook ingest timed out.",
        provider: options.event.provider,
      },
    },
    async () => routeProviderHook(options),
  );

  if (!result.ok) {
    return {
      observations: 0,
      error: result.error,
    };
  }

  const retentionDays = providerObservationRetentionDays(options.retention);
  for (const observation of result.value) {
    await options.persistence.recordProviderObservation({
      ...observation,
      expiresAt: providerObservationExpiresAt(observation.observedAt, retentionDays),
    });
  }

  return {
    observations: result.value.length,
  };
}

async function routeProviderHook(
  options: IngestProviderHookEventOptions,
): Promise<ObservationRecord[]> {
  if (options.event.kind === "worktree") {
    return ingestWorktreeHook(options);
  }
  if (options.event.kind === "terminal") {
    return ingestTerminalHook(options);
  }
  if (options.event.kind === "harness") {
    return ingestHarnessHook(options);
  }

  const worktree = await ingestWorktreeHook(options);
  const terminal = await ingestTerminalHook(options);
  const harness = await ingestHarnessHook(options);
  return [...worktree, ...terminal, ...harness];
}

async function ingestWorktreeHook(
  options: IngestProviderHookEventOptions,
): Promise<ObservationRecord[]> {
  const provider = options.providers.worktree;
  if (provider.id !== options.event.provider || provider.ingestEvent === undefined) {
    return [];
  }
  const observations = await provider.ingestEvent(rawEvent(options.event), {
    projects: options.projects,
  });
  return observations.map(worktreeObservationRecord);
}

async function ingestTerminalHook(
  options: IngestProviderHookEventOptions,
): Promise<ObservationRecord[]> {
  const provider = options.providers.terminals.get(options.event.provider);
  if (provider?.ingestEvent === undefined) {
    return [];
  }
  const observations = await provider.ingestEvent(rawEvent(options.event), {
    projects: options.projects,
    worktrees: [],
  });
  return observations.map(terminalObservationRecord);
}

async function ingestHarnessHook(
  options: IngestProviderHookEventOptions,
): Promise<ObservationRecord[]> {
  const provider = options.providers.harnesses.get(options.event.provider);
  if (provider?.ingestEvent === undefined) {
    return [];
  }
  const context = await harnessEventContext(options);
  const observations = await provider.ingestEvent(rawEvent(options.event), context);
  return observations.map((observation) =>
    harnessEventObservationRecord(options.event, observation),
  );
}

async function harnessEventContext(options: IngestProviderHookEventOptions): Promise<{
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
}> {
  const persisted = await options.persistence.listCurrentProviderEntityObservations({
    entityKind: ["worktree", "terminal_target"],
    now: options.event.receivedAt,
  });
  return {
    projects: options.projects,
    worktrees: latestObservationPayloads(persisted, "worktree", WorktreeObservationSchema),
    terminalTargets: latestObservationPayloads(
      persisted,
      "terminal_target",
      TerminalTargetObservationSchema,
    ),
  };
}

function latestObservationPayloads<T>(
  observations: PersistedProviderObservation[],
  kind: ProviderObservationKind,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
): T[] {
  const latest = new Map<string, T>();
  for (const observation of observations) {
    if (observation.entityKind !== kind) {
      continue;
    }
    const result = schema.safeParse(observation.payload);
    if (!result.success) {
      continue;
    }
    latest.set(observation.entityKey, result.data);
  }
  return [...latest.values()];
}

function rawEvent(event: ProviderHookEvent): {
  provider: string;
  event: unknown;
  observedAt: string;
} {
  return {
    provider: event.provider,
    event: event.payload ?? event.event,
    observedAt: event.receivedAt,
  };
}

function worktreeObservationRecord(observation: WorktreeObservation): ObservationRecord {
  return {
    provider: observation.provider,
    providerType: "worktree",
    entityKind: "worktree",
    entityKey: observation.id,
    payload: observation,
    observedAt: observation.observedAt,
  };
}

function terminalObservationRecord(observation: TerminalTargetObservation): ObservationRecord {
  const payload = stripTerminalProviderData(observation);
  return {
    provider: observation.provider,
    providerType: "terminal",
    entityKind: "terminal_target",
    entityKey: observation.id,
    payload,
    observedAt: observation.observedAt,
  };
}

function harnessEventObservationRecord(
  event: ProviderHookEvent,
  observation: HarnessEventObservation,
): ObservationRecord {
  return {
    provider: observation.provider,
    providerType: "harness",
    entityKind: "harness_event",
    entityKey:
      observation.harnessRunId ??
      observation.sessionId ??
      observation.worktreeId ??
      event.hookId ??
      event.event,
    payload: observation,
    observedAt: observation.observedAt,
  };
}
