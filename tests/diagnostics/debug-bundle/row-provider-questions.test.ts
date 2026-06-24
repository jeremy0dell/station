import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticEvidenceIndex } from "@station/contracts";
import { writeDebugBundle } from "@station/observability";
import { describe, expect, it } from "vitest";
import {
  baseDiagnosticSnapshot,
  baseStationSnapshot,
  diagnosticNow,
  readBundleJson,
} from "../../support/diagnostics";

describe("row-level provider diagnostics from debug bundles", () => {
  it("answers common provider questions without a TUI inspect panel", async () => {
    const diagnosticsDir = await mkdtemp(join(tmpdir(), "station-row-provider-"));
    const manifest = await writeDebugBundle({
      diagnosticsDir,
      now: new Date(diagnosticNow),
      bundleId: "diag_row_provider",
      snapshot: baseDiagnosticSnapshot({
        snapshot: baseStationSnapshot({
          rows: [
            {
              id: "wt_web_debug",
              projectId: "web",
              projectLabel: "web",
              branch: "feature/debug",
              path: "/tmp/station/web/debug",
              worktree: { state: "exists", source: "worktrunk", dirty: true },
              terminal: {
                provider: "tmux",
                state: "open",
                focusable: true,
                closeable: true,
                hasWorkspace: true,
                hasPrimaryAgentEndpoint: true,
                confidence: "high",
                reason: "Terminal is attached to the worktree.",
                observedAt: diagnosticNow,
              },
              agent: {
                harness: "codex",
                state: "working",
                runId: "run_codex_1",
                confidence: "medium",
                reason: "Codex run is active.",
                updatedAt: diagnosticNow,
              },
              display: {
                statusLabel: "working",
                sortPriority: 30,
                alert: false,
              },
            },
          ],
        }),
      }),
    });

    const index = await readBundleJson<DiagnosticEvidenceIndex>(
      manifest.bundlePath,
      "diagnostic-index.json",
    );
    expect(index.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "row-wt_web_debug-provider",
          answer: expect.stringContaining("worktree source worktrunk"),
        }),
        expect.objectContaining({
          id: "row-wt_web_debug-agent-run",
          answer: expect.stringContaining("run_codex_1"),
        }),
      ]),
    );
  });
});
