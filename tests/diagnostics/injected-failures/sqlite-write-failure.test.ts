import { buildDiagnosticEvidenceIndex } from "@station/observability";
import { describe, expect, it } from "vitest";
import { baseDiagnosticSnapshot, diagnosticNow } from "../../support/diagnostics";

describe("SQLite write failure diagnostic", () => {
  it("keeps persistence failure visible in health and bundle evidence", () => {
    const index = buildDiagnosticEvidenceIndex(
      baseDiagnosticSnapshot({
        observerHealth: {
          schemaVersion: "0.8.0",
          status: "degraded",
          pid: 1234,
          startedAt: diagnosticNow,
          version: "0.0.0",
          sqlite: {
            path: "/tmp/station/state/observer.sqlite",
            open: true,
            status: "unavailable",
            schemaVersion: 3,
            lastCheckedAt: diagnosticNow,
            lastError: {
              tag: "PersistenceError",
              code: "PERSISTENCE_TRANSACTION_FAILED",
              message: "Observer SQLite transaction failed.",
              diagnosticId: "err_sqlite",
            },
          },
        },
      }),
    );

    expect(index.summary.rootCauseCodes).toContain("SQLITE_WRITE_FAILURE");
    expect(index.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "sqlite",
          code: "PERSISTENCE_TRANSACTION_FAILED",
          diagnosticId: "err_sqlite",
        }),
      ]),
    );
  });
});
