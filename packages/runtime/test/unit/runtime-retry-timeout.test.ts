import {
  Effect,
  runRuntimeBoundaryWithRetry,
  runRuntimeBoundaryWithTimeout,
  runtimeBoundaryWithRetryEffect,
} from "@station/runtime";
import { describe, expect, it } from "vitest";

const now = "2026-05-20T12:00:00.000Z";

describe("runtime retry and timeout helpers", () => {
  it("retries a failing boundary and preserves trace context", async () => {
    let attempts = 0;
    const result = await runRuntimeBoundaryWithRetry(
      {
        operation: "provider.fake.health",
        clock: { now: () => new Date(now) },
        error: {
          tag: "ProviderUnavailableError",
          code: "PROVIDER_FAILED",
          message: "Provider failed.",
        },
        retry: { retries: 2 },
        trace: { traceId: "trc_retry", spanId: "spn_retry" },
      },
      async () => {
        attempts += 1;
        if (attempts < 2) {
          throw new Error("transient");
        }
        return "ok";
      },
    );

    expect(result).toMatchObject({
      ok: true,
      value: "ok",
      traceId: "trc_retry",
      spanId: "spn_retry",
    });
    expect(attempts).toBe(2);
  });

  it("maps timeout to a typed safe error", async () => {
    let timeoutAborted = false;
    const timeout = await runRuntimeBoundaryWithTimeout(
      {
        operation: "external.fake",
        timeoutMs: 1,
        error: {
          tag: "TimeoutError",
          code: "TIMEOUT_FAKE",
          message: "Fake operation timed out.",
        },
      },
      async ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            timeoutAborted = true;
          });
          setTimeout(resolve, 20);
        }),
    );

    expect(timeout).toMatchObject({
      ok: false,
      error: {
        tag: "TimeoutError",
        code: "TIMEOUT_FAKE",
      },
    });
    expect(timeoutAborted).toBe(true);
  });

  it("keeps retry delays interruptible through the Effect boundary", async () => {
    let attempts = 0;
    const effect = runtimeBoundaryWithRetryEffect(
      { retries: 10, delayMs: 1000 },
      {
        tag: "ProviderUnavailableError",
        code: "PROVIDER_FAILED",
        message: "Provider failed.",
      },
      async () => {
        attempts += 1;
        throw new Error("transient");
      },
    );

    const startedAt = Date.now();
    await expect(
      Effect.runPromise(
        Effect.timeoutFail(effect, {
          duration: "10 millis",
          onTimeout: () => ({
            tag: "TimeoutError",
            code: "RETRY_DELAY_TIMEOUT",
            message: "Retry delay timed out.",
          }),
        }),
      ),
    ).rejects.toThrow("RETRY_DELAY_TIMEOUT");
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(attempts).toBe(1);
  });
});
