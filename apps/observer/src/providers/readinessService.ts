import type {
  HarnessCatalogEntry,
  HarnessReadiness,
  HarnessReadinessFacts,
  ProviderId,
} from "@station/contracts";
import { HarnessReadinessFactsSchema } from "@station/contracts";
import {
  type RuntimeClock,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
  withTimeout,
} from "@station/runtime";
import type { ObservationStore } from "../persistence/index.js";
import { deriveHarnessReadiness, summarizeHarnessReadiness } from "./readinessPolicy.js";
import type { HarnessReadinessRegistration } from "./registry.js";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_FRESHNESS_TTL_MS = 30_000;

export type HarnessReadinessService = {
  initialize(): Promise<void>;
  refreshAll(): Promise<void>;
  refresh(provider: ProviderId): Promise<HarnessReadiness>;
  peek(provider: ProviderId): HarnessReadiness | undefined;
  get(provider: ProviderId): HarnessReadiness;
  catalogEntries(): HarnessCatalogEntry[];
  markTrackingObserved(provider: ProviderId): void;
};

export type CreateHarnessReadinessServiceOptions = {
  catalog: ReadonlyMap<string, HarnessReadinessRegistration>;
  persistence?: Pick<ObservationStore, "listProviderObservations">;
  clock?: RuntimeClock;
  probeTimeoutMs?: number;
  freshnessTtlMs?: number;
};

type CacheRecord = {
  facts: HarnessReadinessFacts;
  freshness: "fresh" | "checking" | "failed";
  trackingObserved: boolean;
  checkedAt?: string;
};

/**
 * USE CASE
 *
 * Maintains process-lifetime readiness truth, coordinating bounded provider
 * probes with persisted tracking evidence and synchronous cache projections.
 */
export function createHarnessReadinessService(
  options: CreateHarnessReadinessServiceOptions,
): HarnessReadinessService {
  const clock = options.clock ?? systemClock;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const freshnessTtlMs = options.freshnessTtlMs ?? DEFAULT_FRESHNESS_TTL_MS;
  const cache = new Map<string, CacheRecord>();
  const flights = new Map<string, Promise<HarnessReadiness>>();
  let initialization: Promise<void> | undefined;

  for (const id of options.catalog.keys()) {
    cache.set(id, {
      facts: unknownFacts(),
      freshness: "checking",
      trackingObserved: false,
    });
  }

  const peek = (provider: ProviderId): HarnessReadiness | undefined => {
    const registration = options.catalog.get(provider);
    const record = cache.get(provider);
    if (registration === undefined || record === undefined) {
      return undefined;
    }
    const freshness = effectiveFreshness(record, clock, freshnessTtlMs);
    const input: Parameters<typeof deriveHarnessReadiness>[0] = {
      registration,
      facts: record.facts,
      freshness,
      trackingObserved: record.trackingObserved,
    };
    if (record.checkedAt !== undefined) {
      input.checkedAt = record.checkedAt;
    }
    return deriveHarnessReadiness(input);
  };

  const get = (provider: ProviderId): HarnessReadiness => {
    const readiness = peek(provider);
    if (readiness === undefined) {
      throw providerNotFound(provider);
    }
    return readiness;
  };

  const runRefresh = async (
    provider: ProviderId,
    registration: HarnessReadinessRegistration,
    record: CacheRecord,
  ): Promise<HarnessReadiness> => {
    try {
      const facts = await withTimeout(
        ({ signal }) => registration.provider.probe({ signal, timeoutMs: probeTimeoutMs }),
        {
          timeoutMs: probeTimeoutMs,
          error: {
            tag: "HarnessReadinessProbeError",
            code: "HARNESS_READINESS_PROBE_FAILED",
            message: "Harness readiness probe failed.",
            provider,
          },
          timeoutError: {
            tag: "TimeoutError",
            code: "HARNESS_READINESS_PROBE_TIMEOUT",
            message: "Harness readiness probe timed out.",
            provider,
          },
        },
      );
      record.facts = HarnessReadinessFactsSchema.parse(facts);
      record.freshness = "fresh";
      record.checkedAt = toIsoTimestamp(clock.now());
    } catch (error) {
      const safeError = safeErrorFromUnknown(error, {
        tag: "HarnessReadinessProbeError",
        code: "HARNESS_READINESS_PROBE_FAILED",
        message: "Harness readiness probe failed.",
        provider,
      });
      record.facts = failedFacts(safeError.code, safeError.message);
      record.freshness = "failed";
      record.checkedAt = toIsoTimestamp(clock.now());
    } finally {
      flights.delete(provider);
    }
    return get(provider);
  };

  const refresh = (provider: ProviderId): Promise<HarnessReadiness> => {
    const existing = flights.get(provider);
    if (existing !== undefined) {
      return existing;
    }
    const registration = options.catalog.get(provider);
    const record = cache.get(provider);
    if (registration === undefined || record === undefined) {
      return Promise.reject(providerNotFound(provider));
    }

    record.freshness = "checking";
    const flight = runRefresh(provider, registration, record);
    flights.set(provider, flight);
    return flight;
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all(Array.from(options.catalog.keys(), (id) => refresh(id)));
  };

  const loadTrackingEvidence = async (): Promise<void> => {
    if (options.persistence === undefined) {
      return;
    }
    const observations = await options.persistence.listProviderObservations({
      entityKind: "harness_event",
      latestOnly: true,
      now: toIsoTimestamp(clock.now()),
    });
    for (const observation of observations) {
      const record = cache.get(observation.provider);
      if (record !== undefined) {
        record.trackingObserved = true;
      }
    }
  };

  const initializeOnce = async (): Promise<void> => {
    let evidenceError: unknown;
    try {
      await loadTrackingEvidence();
    } catch (error) {
      evidenceError = error;
    }
    await refreshAll();
    if (evidenceError !== undefined) {
      throw evidenceError;
    }
  };

  return {
    initialize: () => {
      initialization ??= initializeOnce();
      return initialization;
    },
    refreshAll,
    refresh,
    peek,
    get,
    catalogEntries: () =>
      Array.from(options.catalog.values(), (registration) => {
        const readiness = get(registration.provider.id);
        return {
          id: registration.provider.id,
          label: registration.label,
          kind: registration.kind,
          configuration: registration.configuration,
          readiness: summarizeHarnessReadiness(readiness),
        };
      }),
    markTrackingObserved: (provider) => {
      const record = cache.get(provider);
      if (record !== undefined) {
        record.trackingObserved = true;
      }
    },
  };
}

function effectiveFreshness(
  record: CacheRecord,
  clock: RuntimeClock,
  ttlMs: number,
): HarnessReadiness["freshness"] {
  if (record.freshness !== "fresh" || record.checkedAt === undefined) {
    return record.freshness;
  }
  return clock.now().getTime() - Date.parse(record.checkedAt) > ttlMs ? "stale" : "fresh";
}

function unknownFacts(): HarnessReadinessFacts {
  return {
    cli: "unknown",
    authentication: "unknown",
    launchability: "unknown",
    trackingSetup: "unknown",
    technicalDetails: [],
  };
}

function failedFacts(code: string, message: string): HarnessReadinessFacts {
  return {
    ...unknownFacts(),
    technicalDetails: [{ code, message }],
  };
}

function providerNotFound(provider: ProviderId) {
  return {
    tag: "HarnessReadinessProviderNotFoundError",
    code: "HARNESS_READINESS_PROVIDER_NOT_FOUND",
    message: "The requested harness readiness provider is not in the catalog.",
    provider,
  } as const;
}
