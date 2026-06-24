import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticEvidenceIndex } from "@station/contracts";
import { writeDebugBundle } from "@station/observability";
import { describe, expect, it } from "vitest";
import {
  baseDiagnosticSnapshot,
  diagnosticNow,
  expectBundleRedacted,
  readBundleJson,
  readBundleText,
} from "../../support/diagnostics";

describe("hook auto-start and spool fallback diagnostic", () => {
  it("links spooled hook evidence with redacted hook logs", async () => {
    const diagnosticsDir = await mkdtemp(join(tmpdir(), "station-diag-hook-"));
    const secret = "sk-hooksecret000000000";
    const manifest = await writeDebugBundle({
      diagnosticsDir,
      now: new Date(diagnosticNow),
      bundleId: "diag_hook_spool",
      snapshot: baseDiagnosticSnapshot({
        hookSpool: {
          path: "/tmp/station/state/spool/hooks",
          pending: 1,
          oldestCreatedAt: diagnosticNow,
          newestCreatedAt: diagnosticNow,
        },
        logs: [
          {
            timestamp: diagnosticNow,
            level: "warn",
            component: "hook",
            message: "Hook event spooled for later delivery.",
            provider: "worktrunk",
            attributes: {
              hookId: "hook_1",
              status: "spooled",
              payload: {
                token: secret,
              },
              error: {
                code: "OBSERVER_START_FAILED",
              },
            },
          },
        ],
      }),
    });

    const index = await readBundleJson<DiagnosticEvidenceIndex>(
      manifest.bundlePath,
      "diagnostic-index.json",
    );
    const bundleText = await readBundleText(manifest.bundlePath);
    expect(index.summary.rootCauseCodes).toContain("HOOK_SPOOL_FALLBACK");
    expect(index.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "hook-spool-status",
          answer: expect.stringContaining("1 pending"),
        }),
      ]),
    );
    expectBundleRedacted(bundleText, [secret]);
  });
});
