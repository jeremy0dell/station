import type { HarnessReadinessFacts, HarnessReadinessProvider } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { createHarnessReadinessService } from "../../src/providers/readinessService.js";
import type { HarnessReadinessRegistration } from "../../src/providers/registry.js";

function readyFacts(): HarnessReadinessFacts {
  return {
    cli: "available",
    authentication: "ready",
    launchability: "ready",
    trackingSetup: "prepared",
    installedVersion: "1.2.3",
    technicalDetails: [],
  };
}

function catalog(provider: HarnessReadinessProvider) {
  const registration: HarnessReadinessRegistration = {
    provider,
    label: "Codex",
    kind: "built_in",
    configuration: "configured",
    preparation: { prepare: true, repair: true },
  };
  return new Map([[provider.id, registration]]);
}

function testClock() {
  let now = Date.parse("2026-07-12T12:00:00.000Z");
  return {
    clock: { now: () => new Date(now) } satisfies RuntimeClock,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("createHarnessReadinessService", () => {
  it("starts checking, refreshes one provider, and expires synchronously", async () => {
    const { clock, advance } = testClock();
    const probe = vi.fn(async () => readyFacts());
    const service = createHarnessReadinessService({
      catalog: catalog({ id: "codex", probe }),
      clock,
      freshnessTtlMs: 30_000,
    });

    expect(service.catalogEntries()[0]?.readiness.status).toBe("checking");
    const refreshed = await service.refresh("codex");
    expect(refreshed.freshness).toBe("fresh");
    expect(refreshed.installedVersion).toBe("1.2.3");
    advance(30_001);
    expect(service.get("codex").freshness).toBe("stale");
    expect(service.get("codex").decision).toBe("unknown");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("single-flights targeted refreshes and preserves revision for unchanged facts", async () => {
    let release: (() => void) | undefined;
    const probe = vi
      .fn<() => Promise<HarnessReadinessFacts>>()
      .mockImplementationOnce(
        () =>
          new Promise<HarnessReadinessFacts>((resolve) => {
            release = () => resolve(readyFacts());
          }),
      )
      .mockResolvedValue(readyFacts());
    const service = createHarnessReadinessService({
      catalog: catalog({ id: "codex", probe }),
    });

    const first = service.refresh("codex");
    const second = service.refresh("codex");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(secondResult.revision).toBe(firstResult.revision);

    const thirdResult = await service.refresh("codex");
    expect(thirdResult.revision).toBe(firstResult.revision);
  });

  it("refreshes only the requested catalog provider", async () => {
    const codexProbe = vi.fn(async () => readyFacts());
    const cursorProbe = vi.fn(async () => readyFacts());
    const service = createHarnessReadinessService({
      catalog: new Map([
        ...catalog({ id: "codex", probe: codexProbe }),
        [
          "cursor",
          {
            provider: { id: "cursor", probe: cursorProbe },
            label: "Cursor Agent",
            kind: "built_in" as const,
            configuration: "not_configured" as const,
            preparation: { prepare: true, repair: true },
          },
        ],
      ]),
    });

    await service.refresh("cursor");
    expect(cursorProbe).toHaveBeenCalledTimes(1);
    expect(codexProbe).not.toHaveBeenCalled();
  });

  it("loads persisted tracking evidence once and upgrades prepared to ready", async () => {
    const listProviderObservations = vi.fn(async () => [
      {
        provider: "codex",
        entityKind: "harness_event" as const,
      },
    ]);
    const service = createHarnessReadinessService({
      catalog: catalog({ id: "codex", probe: async () => readyFacts() }),
      persistence: { listProviderObservations } as never,
    });

    await service.initialize();
    await service.initialize();
    expect(service.catalogEntries()[0]?.readiness.status).toBe("ready");
    expect(listProviderObservations).toHaveBeenCalledTimes(1);
  });

  it("replaces prior ready facts when a refresh fails", async () => {
    const probe = vi
      .fn<() => Promise<HarnessReadinessFacts>>()
      .mockResolvedValueOnce(readyFacts())
      .mockRejectedValueOnce(new Error("private provider failure"));
    const service = createHarnessReadinessService({
      catalog: catalog({ id: "codex", probe }),
    });

    expect((await service.refresh("codex")).decision).toBe("launch_ready");
    const failed = await service.refresh("codex");
    expect(failed.freshness).toBe("failed");
    expect(failed.decision).toBe("unknown");
    expect(failed.installedVersion).toBeUndefined();
    expect(failed.technicalDetails).toEqual([
      {
        code: "HARNESS_READINESS_PROBE_FAILED",
        message: "Harness readiness probe failed.",
      },
    ]);
  });

  it("returns the catalog-specific SafeError for an unknown provider", async () => {
    const service = createHarnessReadinessService({
      catalog: new Map(),
    });
    await expect(service.refresh("missing")).rejects.toMatchObject({
      code: "HARNESS_READINESS_PROVIDER_NOT_FOUND",
      provider: "missing",
    });
  });
});
