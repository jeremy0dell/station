import type { ProviderHealth } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { ProviderHealthCache, type ProviderHealthProbeTarget } from "../../src/internal";

const now = "2026-05-20T12:00:00.000Z";

function healthyResult(providerId: string): ProviderHealth {
  return {
    providerId,
    providerType: "harness",
    status: "healthy",
    lastCheckedAt: now,
    latencyMs: 1,
    capabilities: { canLaunch: true },
  };
}

function target(
  providerId: string,
  health: () => Promise<ProviderHealth>,
): ProviderHealthProbeTarget {
  return {
    providerId,
    providerType: "harness",
    capabilities: () => ({ canLaunch: true }),
    health,
  };
}

function testClock(startMs = 0) {
  let ms = startMs;
  return {
    clock: { now: () => new Date(ms) },
    advance: (deltaMs: number) => {
      ms += deltaMs;
    },
  };
}

describe("provider health cache", () => {
  it("returns undefined before the first probe and populates in the background", async () => {
    const probe = vi.fn(async () => healthyResult("fake"));
    const cache = new ProviderHealthCache({ targets: [target("fake", probe)] });

    expect(cache.read("fake")).toBeUndefined();

    // Joins the background probe the read triggered.
    await cache.refresh("fake");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cache.read("fake")?.status).toBe("healthy");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("probes every registered provider on refreshAll", async () => {
    const first = vi.fn(async () => healthyResult("one"));
    const second = vi.fn(async () => healthyResult("two"));
    const cache = new ProviderHealthCache({
      targets: [target("one", first), target("two", second)],
    });

    await cache.refreshAll();

    expect(cache.read("one")?.status).toBe("healthy");
    expect(cache.read("two")?.status).toBe("healthy");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("notifies once when callers join the same probe", async () => {
    let resolveProbe: (health: ProviderHealth) => void = () => undefined;
    const probe = vi.fn(
      () =>
        new Promise<ProviderHealth>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const listener = vi.fn(async () => undefined);
    const cache = new ProviderHealthCache({ targets: [target("fake", probe)] });
    cache.onProbeCompleted(listener);

    const first = cache.refresh("fake");
    const second = cache.refresh("fake");
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    resolveProbe(healthyResult("fake"));
    await Promise.all([first, second]);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(healthyResult("fake"));
  });

  it("lets launch waiters use fresh cache evidence while ordinary refresh awaits publication", async () => {
    let releaseListener = () => undefined;
    const listenerBlocked = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    let markListenerStarted = () => undefined;
    const listenerStarted = new Promise<void>((resolve) => {
      markListenerStarted = resolve;
    });
    const cache = new ProviderHealthCache({
      targets: [target("fake", async () => healthyResult("fake"))],
    });
    cache.onProbeCompleted(async () => {
      markListenerStarted();
      await listenerBlocked;
    });

    let refreshCompleted = false;
    const refresh = cache.refresh("fake").then(() => {
      refreshCompleted = true;
    });
    await cache.refreshUntilCached("fake");

    expect(cache.read("fake")?.status).toBe("healthy");
    expect(refreshCompleted).toBe(false);
    await listenerStarted;
    releaseListener();
    await refresh;
    expect(refreshCompleted).toBe(true);
  });

  it("keeps refresh non-rejecting when a completion listener fails", async () => {
    const cache = new ProviderHealthCache({
      targets: [target("fake", async () => healthyResult("fake"))],
    });
    cache.onProbeCompleted(async () => {
      throw new Error("publication failed");
    });

    await expect(cache.refresh("fake")).resolves.toBeUndefined();
    expect(cache.read("fake")?.status).toBe("healthy");
  });

  it("serves stale entries past the TTL while revalidating once in the background", async () => {
    const { clock, advance } = testClock();
    let resolveRevalidation: (value: ProviderHealth) => void = () => undefined;
    const probe = vi.fn((): Promise<ProviderHealth> => {
      if (probe.mock.calls.length === 1) {
        return Promise.resolve(healthyResult("fake"));
      }
      return new Promise((resolve) => {
        resolveRevalidation = resolve;
      });
    });
    const cache = new ProviderHealthCache({
      targets: [target("fake", probe)],
      ttlMs: 1000,
      clock,
    });
    await cache.refreshAll();

    advance(1001);
    expect(cache.read("fake")?.status).toBe("healthy");
    expect(cache.read("fake")?.status).toBe("healthy");
    // Both stale reads share one in-flight revalidation (the probe itself
    // starts on a later tick inside the runtime boundary).
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

    resolveRevalidation({ ...healthyResult("fake"), status: "degraded" });
    await vi.waitFor(() => expect(cache.read("fake")?.status).toBe("degraded"));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("caches a failed probe as unavailable with the error", async () => {
    const cache = new ProviderHealthCache({
      targets: [
        target("fake", async () => {
          throw {
            tag: "ProviderUnavailableError",
            code: "FAKE_HEALTH_FAILED",
            message: "The fake provider health check failed.",
            provider: "fake",
          };
        }),
      ],
    });

    await cache.refreshAll();

    expect(cache.read("fake")).toMatchObject({
      status: "unavailable",
      lastError: { code: "FAKE_HEALTH_FAILED" },
      capabilities: { canLaunch: true },
    });
  });

  it("times out hung probes instead of caching forever", async () => {
    const cache = new ProviderHealthCache({
      targets: [target("fake", () => new Promise<never>(() => undefined))],
      timeoutMs: 20,
    });

    await cache.refresh("fake");

    expect(cache.read("fake")).toMatchObject({
      status: "unavailable",
      lastError: { code: "PROVIDER_TIMEOUT" },
    });
  });

  it("re-probes on eager refresh even when the entry is fresh", async () => {
    const statuses: ProviderHealth["status"][] = ["healthy", "unavailable"];
    const probe = vi.fn(async () => ({
      ...healthyResult("fake"),
      status: statuses[Math.min(probe.mock.calls.length - 1, 1)] ?? "unavailable",
    }));
    const cache = new ProviderHealthCache({ targets: [target("fake", probe)] });
    await cache.refreshAll();
    expect(cache.read("fake")?.status).toBe("healthy");

    await cache.refresh("fake");

    expect(probe).toHaveBeenCalledTimes(2);
    expect(cache.read("fake")?.status).toBe("unavailable");
  });

  it("resolves refresh for unknown providers without probing", async () => {
    const cache = new ProviderHealthCache({ targets: [] });
    await expect(cache.refresh("missing")).resolves.toBeUndefined();
    expect(cache.read("missing")).toBeUndefined();
  });
});
