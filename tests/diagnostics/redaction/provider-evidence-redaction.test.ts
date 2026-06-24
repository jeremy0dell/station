import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDebugBundle } from "@station/observability";
import { describe, expect, it } from "vitest";
import {
  baseDiagnosticSnapshot,
  diagnosticNow,
  expectBundleRedacted,
  readBundleText,
} from "../../support/diagnostics";

describe("provider evidence redaction", () => {
  it("redacts secrets from every bundle section including diagnostic-index.json", async () => {
    const diagnosticsDir = await mkdtemp(join(tmpdir(), "station-redaction-"));
    const token = "sk-providersecret000000000";
    const bearer = "Bearer providerBearerSecretValue";
    const manifest = await writeDebugBundle({
      diagnosticsDir,
      now: new Date(diagnosticNow),
      bundleId: "diag_redaction",
      snapshot: baseDiagnosticSnapshot({
        providerHealth: {
          "fake-harness": {
            providerId: "fake-harness",
            providerType: "harness",
            status: "unavailable",
            lastCheckedAt: diagnosticNow,
            lastError: {
              tag: "HarnessProviderError",
              code: "HARNESS_UNEXPECTED_EXIT",
              message: `Harness failed with ${token}.`,
              provider: "fake-harness",
            },
            diagnostics: {
              authorization: bearer,
              transcript: `raw output ${token}`,
            },
          },
        },
      }),
    });

    const bundleText = await readBundleText(manifest.bundlePath);
    expectBundleRedacted(bundleText, [token, bearer]);
    expect(bundleText).toContain("[REDACTED]");
  });
});
