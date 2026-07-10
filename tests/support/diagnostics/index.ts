import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DiagnosticEvidenceIndex,
  DiagnosticSnapshot,
  RedactionReport,
  StationSnapshot,
} from "@station/contracts";
import { expect } from "vitest";

export const diagnosticNow = "2026-05-22T12:00:00.000Z";

export async function readBundleText(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  const contents: string[] = [];
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      contents.push(await readBundleText(childPath));
      continue;
    }
    contents.push(await readFile(childPath, "utf8"));
  }
  return contents.join("\n");
}

export async function readBundleJson<T>(bundlePath: string, section: string): Promise<T> {
  return JSON.parse(await readFile(join(bundlePath, section), "utf8")) as T;
}

export function expectBundleRedacted(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

export function findEvidenceItem(
  index: DiagnosticEvidenceIndex,
  code: string,
): DiagnosticEvidenceIndex["items"][number] | undefined {
  return index.items.find((item) => item.code === code);
}

export function baseDiagnosticSnapshot(
  overrides: Partial<DiagnosticSnapshot> = {},
): DiagnosticSnapshot {
  const snapshot: DiagnosticSnapshot = {
    schemaVersion: "0.7.0",
    collectedAt: diagnosticNow,
    observerHealth: {
      schemaVersion: "0.7.0",
      status: "healthy",
      pid: 1234,
      startedAt: diagnosticNow,
      version: "0.0.0",
    },
    snapshot: baseStationSnapshot(),
    providerHealth: {},
    commands: [],
    events: [],
    errors: [],
    logs: [],
  };
  return { ...snapshot, ...overrides };
}

export function baseStationSnapshot(overrides: Partial<StationSnapshot> = {}): StationSnapshot {
  const snapshot: StationSnapshot = {
    schemaVersion: "0.7.0",
    generatedAt: diagnosticNow,
    observer: {
      pid: 1234,
      startedAt: diagnosticNow,
      version: "0.0.0",
      healthy: true,
    },
    providerHealth: {},
    projects: [],
    rows: [],
    sessions: [],
    counts: {
      projects: 0,
      worktrees: 0,
      agents: 0,
      working: 0,
      idle: 0,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  };
  return { ...snapshot, ...overrides };
}

export function redactionReport(): RedactionReport {
  return {
    policyVersion: "station-redaction-v1",
    generatedAt: diagnosticNow,
    redactedFields: [],
    redactedPatterns: [],
    replacements: 0,
    suspiciousSecretsFound: 0,
  };
}
