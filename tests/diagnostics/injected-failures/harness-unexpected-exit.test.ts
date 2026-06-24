import { buildDiagnosticEvidenceIndex } from "@station/observability";
import { describe, expect, it } from "vitest";
import {
  baseDiagnosticSnapshot,
  baseStationSnapshot,
  diagnosticNow,
} from "../../support/diagnostics";

describe("harness unexpected exit diagnostic", () => {
  it("classifies exited harness evidence and preserves row-level run id", () => {
    const index = buildDiagnosticEvidenceIndex(
      baseDiagnosticSnapshot({
        snapshot: baseStationSnapshot({
          rows: [
            {
              id: "wt_web_exit",
              projectId: "web",
              projectLabel: "web",
              branch: "feature/exit",
              path: "/tmp/station/web/exit",
              worktree: { state: "exists", source: "worktrunk" },
              agent: {
                harness: "scripted",
                state: "exited",
                runId: "run_exit_7",
                confidence: "high",
                reason: "Scripted agent exited unexpectedly with code 7.",
                updatedAt: diagnosticNow,
              },
              display: {
                statusLabel: "exited",
                sortPriority: 60,
                alert: false,
                warning: true,
                reason: "Scripted agent exited unexpectedly with code 7.",
              },
            },
          ],
        }),
        errors: [
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
      }),
    );

    expect(index.summary.rootCauseCodes).toContain("HARNESS_UNEXPECTED_EXIT");
    expect(index.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "row-wt_web_exit-agent-run",
          answer: expect.stringContaining("run_exit_7"),
        }),
      ]),
    );
  });
});
