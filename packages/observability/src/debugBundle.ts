import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DebugBundleManifest,
  DebugBundleManifestSchema,
  type DiagnosticSnapshot,
  type RedactionReport,
  STATION_SCHEMA_VERSION,
} from "@station/contracts";
import { buildDiagnosticEvidenceIndex } from "./evidence.js";
import { mergeRedactionReports, REDACTION_POLICY_VERSION, redact } from "./redaction.js";

export type WriteDebugBundleInput = {
  diagnosticsDir: string;
  snapshot: DiagnosticSnapshot;
  now?: Date;
  version?: string;
  bundleId?: string;
};

export async function writeDebugBundle(input: WriteDebugBundleInput): Promise<DebugBundleManifest> {
  const now = input.now ?? new Date();
  const bundleId = input.bundleId ?? `diag_${now.toISOString().replaceAll(/[:.]/g, "-")}`;
  const bundlePath = join(input.diagnosticsDir, bundleId);
  await mkdir(join(bundlePath, "logs"), { recursive: true, mode: 0o700 });

  const reports: RedactionReport[] = [];
  const redactedSnapshot = redact(input.snapshot, now);
  reports.push(redactedSnapshot.report);
  const diagnostics = redactedSnapshot.value;

  const sections = [
    "manifest.json",
    "config-summary.json",
    "observer-health.json",
    "snapshot.json",
    "provider-health.json",
    "diagnostic-index.json",
    "commands.jsonl",
    "events.jsonl",
    "errors.jsonl",
    "spool-summary.json",
    "local-state.json",
    "retention.json",
    "redaction-report.json",
    "README.txt",
  ];

  await writeJson(join(bundlePath, "config-summary.json"), diagnostics.configSummary ?? {});
  await writeJson(join(bundlePath, "observer-health.json"), diagnostics.observerHealth);
  await writeJson(join(bundlePath, "snapshot.json"), diagnostics.snapshot);
  await writeJson(join(bundlePath, "provider-health.json"), diagnostics.providerHealth);
  const evidenceIndex = buildDiagnosticEvidenceIndex(diagnostics, {
    generatedAt: now,
    bundleId,
    redaction: "redacted",
  });
  const redactedEvidenceIndex = redact(evidenceIndex, now);
  reports.push(redactedEvidenceIndex.report);
  await writeJson(join(bundlePath, "diagnostic-index.json"), redactedEvidenceIndex.value);
  await writeJson(join(bundlePath, "spool-summary.json"), diagnostics.hookSpool ?? {});
  await writeJson(join(bundlePath, "local-state.json"), diagnostics.localState ?? {});
  await writeJson(join(bundlePath, "retention.json"), diagnostics.retention ?? {});
  await writeJsonl(join(bundlePath, "commands.jsonl"), diagnostics.commands);
  await writeJsonl(join(bundlePath, "events.jsonl"), diagnostics.events);
  await writeJsonl(join(bundlePath, "errors.jsonl"), diagnostics.errors);
  await writeJsonl(join(bundlePath, "logs", "observer.jsonl"), diagnostics.logs);
  await writeFile(
    join(bundlePath, "README.txt"),
    [
      "stn debug bundle",
      "",
      "Start with diagnostic-index.json, observer-health.json, provider-health.json, commands.jsonl, errors.jsonl, and logs/observer.jsonl.",
      "All sections are redacted diagnostic evidence, not runtime truth.",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );

  const redactionReport = mergeRedactionReports(reports, now.toISOString());
  await writeJson(join(bundlePath, "redaction-report.json"), redactionReport);

  const manifest = DebugBundleManifestSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    bundleId,
    createdAt: now.toISOString(),
    bundlePath,
    stationVersion: input.version ?? "0.0.0",
    platform: process.platform,
    nodeVersion: process.version,
    redactionPolicyVersion: REDACTION_POLICY_VERSION,
    sections,
    commandIds: diagnostics.commands.map((command) => command.id),
    traceIds: unique([
      ...diagnostics.commands.flatMap((command) =>
        command.traceId === undefined ? [] : [command.traceId],
      ),
      ...diagnostics.logs.flatMap((log) => (log.traceId === undefined ? [] : [log.traceId])),
    ]),
    redactionReport,
  });
  await writeJson(join(bundlePath, "manifest.json"), manifest);

  return manifest;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeJsonl(path: string, values: readonly unknown[]): Promise<void> {
  await writeFile(
    path,
    values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : ""),
    { encoding: "utf8", mode: 0o600 },
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
