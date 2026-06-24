import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticEvidenceIndex } from "@station/contracts";
import { writeDebugBundle } from "@station/observability";
import { describe, expect, it } from "vitest";
import {
  baseDiagnosticSnapshot,
  diagnosticNow,
  readBundleJson,
  readBundleText,
} from "../../support/diagnostics";

describe("missing Worktrunk binary diagnostic", () => {
  it("is diagnosable from one redacted debug bundle", async () => {
    const diagnosticsDir = await mkdtemp(join(tmpdir(), "station-diag-wt-"));
    const manifest = await writeDebugBundle({
      diagnosticsDir,
      now: new Date(diagnosticNow),
      bundleId: "diag_missing_worktrunk",
      snapshot: baseDiagnosticSnapshot({
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
      }),
    });

    const index = await readBundleJson<DiagnosticEvidenceIndex>(
      manifest.bundlePath,
      "diagnostic-index.json",
    );
    expect(index.summary.rootCauseCodes).toContain("MISSING_WORKTRUNK_BINARY");
    expect(index.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WORKTRUNK_UNAVAILABLE",
          provider: "worktrunk",
        }),
      ]),
    );
    expect(await readBundleText(manifest.bundlePath)).toContain("brew install worktrunk");
  });
});
