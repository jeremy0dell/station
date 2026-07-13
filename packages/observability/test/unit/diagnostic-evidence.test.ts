import { buildDiagnosticEvidenceIndex } from "@station/observability";
import { describe, expect, it } from "vitest";
import {
  baseDiagnosticSnapshot,
  baseStationSnapshot,
  diagnosticNow,
  findEvidenceItem,
} from "../../../../tests/support/diagnostics";

describe("diagnostic evidence index", () => {
  it("classifies a missing Worktrunk binary from provider health and command evidence", () => {
    const index = buildDiagnosticEvidenceIndex(
      baseDiagnosticSnapshot({
        providerHealth: {
          worktrunk: {
            providerId: "worktrunk",
            providerType: "worktree",
            status: "unavailable",
            lastCheckedAt: diagnosticNow,
            lastError: {
              tag: "ProviderUnavailableError",
              code: "WORKTRUNK_UNAVAILABLE",
              message: "Worktrunk is not available.",
              hint: "Install Worktrunk with brew install worktrunk.",
              provider: "worktrunk",
              diagnosticId: "err_wt",
            },
            diagnostics: {
              attemptedCommand: "missing-wt",
              installHint: "brew install worktrunk",
            },
          },
        },
        commands: [
          {
            id: "cmd_create_1",
            type: "session.create",
            command: {
              type: "session.create",
              payload: {
                projectId: "web",
                branch: "feature/wt",
                harness: { provider: "fake-harness" },
                terminal: { provider: "fake-terminal" },
              },
            },
            status: "failed",
            createdAt: diagnosticNow,
            traceId: "trc_wt",
            spanId: "spn_wt",
            error: {
              tag: "ProviderUnavailableError",
              code: "WORKTRUNK_UNAVAILABLE",
              message: "Worktrunk is not available.",
              provider: "worktrunk",
              diagnosticId: "err_wt",
            },
          },
        ],
      }),
      { bundleId: "diag_wt" },
    );

    expect(index.summary.rootCauseCodes).toContain("MISSING_WORKTRUNK_BINARY");
    expect(index.summary.providers).toContain("worktrunk");
    expect(index.summary.commandIds).toContain("cmd_create_1");
    expect(findEvidenceItem(index, "WORKTRUNK_UNAVAILABLE")).toMatchObject({
      category: "provider",
      provider: "worktrunk",
      diagnosticId: "err_wt",
    });
  });

  it("indexes stale terminal targets, provider timeouts, harness exits, SQLite failures, and hook spool fallback", () => {
    const index = buildDiagnosticEvidenceIndex(
      baseDiagnosticSnapshot({
        observerHealth: {
          schemaVersion: "0.8.0",
          status: "degraded",
          pid: 1234,
          startedAt: diagnosticNow,
          version: "0.0.0",
          sqlite: {
            path: "/tmp/station/observer.sqlite",
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
          lastReconcile: {
            reason: "diagnostic-test",
            startedAt: diagnosticNow,
            finishedAt: diagnosticNow,
            durationMs: 1000,
            errors: [
              {
                tag: "TimeoutError",
                code: "PROVIDER_TIMEOUT",
                message: "Provider operation timed out.",
                provider: "fake-harness",
              },
            ],
          },
        },
        snapshot: baseStationSnapshot({
          rows: [
            {
              id: "wt_web_stale",
              projectId: "web",
              projectLabel: "web",
              branch: "feature/stale",
              path: "/tmp/station/web/feature-stale",
              worktree: { state: "exists", source: "worktrunk" },
              terminal: {
                provider: "tmux",
                state: "stale",
                closeable: true,
                hasWorkspace: true,
                hasPrimaryAgentEndpoint: true,
                confidence: "high",
                reason: "Terminal target is stale.",
                observedAt: diagnosticNow,
              },
              agent: {
                harness: "scripted",
                state: "exited",
                runId: "run_exit_1",
                confidence: "high",
                reason: "Scripted agent exited unexpectedly with code 7.",
                updatedAt: diagnosticNow,
              },
              display: {
                statusLabel: "exited",
                sortPriority: 60,
                alert: false,
                warning: true,
                reason: "Terminal target is stale.",
              },
            },
          ],
        }),
        providerHealth: {
          "fake-harness": {
            providerId: "fake-harness",
            providerType: "harness",
            status: "unavailable",
            lastCheckedAt: diagnosticNow,
            lastError: {
              tag: "TimeoutError",
              code: "PROVIDER_TIMEOUT",
              message: "Provider operation timed out.",
              provider: "fake-harness",
            },
          },
        },
        events: [
          {
            type: "providerHook.spoolDrained",
            at: diagnosticNow,
            drained: 0,
            failed: 1,
          },
        ],
        errors: [
          {
            id: "err_terminal",
            tag: "TerminalProviderError",
            code: "TERMINAL_TARGET_STALE",
            message: "The terminal target is stale.",
            severity: "error",
            provider: "tmux",
            commandId: "cmd_focus_1",
            redacted: true,
            createdAt: diagnosticNow,
          },
          {
            id: "err_exit",
            tag: "HarnessProviderError",
            code: "HARNESS_UNEXPECTED_EXIT",
            message: "Harness process exited unexpectedly.",
            severity: "error",
            provider: "scripted",
            redacted: true,
            createdAt: diagnosticNow,
          },
        ],
        hookSpool: {
          path: "/tmp/station/state/spool/hooks",
          pending: 1,
          oldestCreatedAt: diagnosticNow,
          newestCreatedAt: diagnosticNow,
        },
      }),
    );

    expect(index.summary.rootCauseCodes).toEqual(
      expect.arrayContaining([
        "STALE_TERMINAL_TARGET",
        "PROVIDER_TIMEOUT",
        "HARNESS_UNEXPECTED_EXIT",
        "SQLITE_WRITE_FAILURE",
        "HOOK_SPOOL_FALLBACK",
      ]),
    );
    expect(index.questions.map((question) => question.id)).toEqual(
      expect.arrayContaining(["row-wt_web_stale-provider", "hook-spool-status"]),
    );
  });
});
