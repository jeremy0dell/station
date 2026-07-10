import { buildDiagnosticEvidenceIndex } from "@station/observability";
import { describe, expect, it } from "vitest";
import { baseDiagnosticSnapshot, diagnosticNow } from "../../support/diagnostics";

describe("provider timeout diagnostic", () => {
  it("links provider health, reconcile timing, and timeout code", () => {
    const index = buildDiagnosticEvidenceIndex(
      baseDiagnosticSnapshot({
        observerHealth: {
          schemaVersion: "0.7.0",
          status: "degraded",
          pid: 1234,
          startedAt: diagnosticNow,
          version: "0.0.0",
          lastReconcile: {
            reason: "provider-timeout",
            startedAt: diagnosticNow,
            finishedAt: diagnosticNow,
            durationMs: 5000,
            errors: [
              {
                tag: "TimeoutError",
                code: "PROVIDER_TIMEOUT",
                message: "Provider operation timed out.",
                provider: "fake-worktree",
              },
            ],
          },
        },
        providerHealth: {
          "fake-worktree": {
            providerId: "fake-worktree",
            providerType: "worktree",
            status: "unavailable",
            lastCheckedAt: diagnosticNow,
            latencyMs: 5000,
            lastError: {
              tag: "TimeoutError",
              code: "PROVIDER_TIMEOUT",
              message: "Provider operation timed out.",
              provider: "fake-worktree",
            },
          },
        },
      }),
    );

    expect(index.summary.rootCauseCodes).toContain("PROVIDER_TIMEOUT");
    expect(index.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "observer",
          code: "RECONCILE_ERROR",
          provider: "fake-worktree",
        }),
        expect.objectContaining({
          category: "provider",
          code: "PROVIDER_TIMEOUT",
          provider: "fake-worktree",
        }),
      ]),
    );
  });
});
