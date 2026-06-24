import { Effect, runRuntimeBoundary, runtimeBoundaryEffect } from "@station/runtime";
import { describe, expect, it } from "vitest";

const now = "2026-05-20T12:00:00.000Z";

describe("runtime Effect boundaries", () => {
  it("exposes an Effect-native provider boundary helper", async () => {
    const effect = runtimeBoundaryEffect(
      {
        error: {
          tag: "ProviderUnavailableError",
          code: "PROVIDER_FAILED",
          message: "Provider failed.",
          provider: "fake",
        },
      },
      async () => "ok",
    );

    await expect(Effect.runPromise(effect)).resolves.toBe("ok");
  });

  it("maps thrown errors through the Promise facade while preserving timing", async () => {
    const result = await runRuntimeBoundary(
      {
        operation: "provider.fake.list",
        clock: {
          now: () => new Date(now),
        },
        error: {
          tag: "ProviderUnavailableError",
          code: "PROVIDER_FAILED",
          message: "Provider failed.",
          provider: "fake",
        },
      },
      async () => {
        throw new Error("internal stack should not leak");
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        tag: "ProviderUnavailableError",
        code: "PROVIDER_FAILED",
        message: "Provider failed.",
        provider: "fake",
      },
      timing: {
        operation: "provider.fake.list",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
      },
    });
  });
});
