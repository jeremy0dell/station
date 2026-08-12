import type { ProviderHealth, ProviderId } from "@station/contracts";
import { type RuntimeClock, runRuntimeBoundaryWithTimeout, systemClock } from "@station/runtime";

export type ProviderHealthProbeTarget = {
  providerId: ProviderId;
  providerType: ProviderHealth["providerType"];
  capabilities: () => Record<string, boolean>;
  health: () => Promise<ProviderHealth>;
};

export type ProviderHealthCacheTuning = {
  /** Entries older than this are served stale while a background probe refreshes them. */
  ttlMs?: number;
  timeoutMs?: number;
  clock?: RuntimeClock;
};

export type ProviderHealthCacheOptions = ProviderHealthCacheTuning & {
  targets: readonly ProviderHealthProbeTarget[];
};

export type ProviderHealthProbeCompletedListener = (health: ProviderHealth) => Promise<void> | void;

type CacheEntry = {
  health: ProviderHealth;
  refreshedAtMs: number;
};

type InFlightProbe = {
  cacheReady: Promise<void>;
  complete: Promise<void>;
};

/**
 * Out-of-band provider health cache: reconcile reads synchronously and never
 * awaits a health probe during reconcile. Explicit launch preflights await fresh
 * cached evidence without waiting for its serialized snapshot publication. Each
 * unique probe still notifies completion listeners before its in-flight slot clears,
 * including boot, stale, eager, and launch refreshes.
 * `stn doctor` keeps probing providers live, bypassing this cache.
 */
export class ProviderHealthCache {
  readonly #targets: Map<string, ProviderHealthProbeTarget>;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #clock: RuntimeClock;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, InFlightProbe>();
  readonly #probeCompletedListeners = new Set<ProviderHealthProbeCompletedListener>();

  constructor(options: ProviderHealthCacheOptions) {
    this.#targets = new Map(options.targets.map((target) => [target.providerId, target]));
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#clock = options.clock ?? systemClock;
  }

  /** Synchronous read; a missing or stale entry triggers one background probe. */
  read(providerId: string): ProviderHealth | undefined {
    const entry = this.#entries.get(providerId);
    if (entry === undefined || this.#nowMs() - entry.refreshedAtMs >= this.#ttlMs) {
      void this.refresh(providerId);
    }
    return entry?.health;
  }

  /** Probe one provider now, ignoring TTL. Never rejects; joins an in-flight probe. */
  refresh(providerId: string): Promise<void> {
    return this.#getOrStartProbe(providerId)?.complete ?? Promise.resolve();
  }

  /**
   * Probe one provider and resolve when fresh evidence is readable from the cache.
   * Completion publication remains part of the same in-flight probe.
   */
  refreshUntilCached(providerId: string): Promise<void> {
    return this.#getOrStartProbe(providerId)?.cacheReady ?? Promise.resolve();
  }

  #getOrStartProbe(providerId: string): InFlightProbe | undefined {
    const inFlight = this.#inFlight.get(providerId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const target = this.#targets.get(providerId);
    if (target === undefined) {
      return undefined;
    }
    let markCacheReady: () => void = () => undefined;
    const cacheReady = new Promise<void>((resolve) => {
      markCacheReady = resolve;
    });
    const complete = this.#probe(target, markCacheReady).finally(() => {
      markCacheReady();
      this.#inFlight.delete(providerId);
    });
    const probe = { cacheReady, complete };
    this.#inFlight.set(providerId, probe);
    return probe;
  }

  onProbeCompleted(listener: ProviderHealthProbeCompletedListener): () => void {
    this.#probeCompletedListeners.add(listener);
    return () => {
      this.#probeCompletedListeners.delete(listener);
    };
  }

  async refreshAll(): Promise<void> {
    await Promise.all(Array.from(this.#targets.keys(), (providerId) => this.refresh(providerId)));
  }

  async #probe(target: ProviderHealthProbeTarget, markCacheReady: () => void): Promise<void> {
    const result = await runRuntimeBoundaryWithTimeout(
      {
        operation: `provider.${target.providerId}.health`,
        clock: this.#clock,
        timeoutMs: this.#timeoutMs,
        error: {
          tag: "ProviderUnavailableError",
          code: "PROVIDER_HEALTH_FAILED",
          message: "The provider health check failed.",
          provider: target.providerId,
        },
        timeoutError: {
          tag: "TimeoutError",
          code: "PROVIDER_TIMEOUT",
          message: "Provider health check timed out.",
          provider: target.providerId,
        },
      },
      () => target.health(),
    );
    const health: ProviderHealth = result.ok
      ? {
          ...result.value,
          latencyMs: result.value.latencyMs ?? result.timing.durationMs,
          capabilities: result.value.capabilities ?? target.capabilities(),
        }
      : {
          providerId: target.providerId,
          providerType: target.providerType,
          status: "unavailable",
          lastCheckedAt: result.timing.finishedAt,
          lastError: result.error,
          latencyMs: result.timing.durationMs,
          capabilities: target.capabilities(),
        };
    this.#entries.set(target.providerId, { health, refreshedAtMs: this.#nowMs() });
    markCacheReady();
    const notifications = Array.from(this.#probeCompletedListeners, (listener) =>
      Promise.resolve().then(() => listener(health)),
    );
    await Promise.allSettled(notifications);
  }

  #nowMs(): number {
    return this.#clock.now().getTime();
  }
}
