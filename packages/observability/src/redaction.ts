import type { RedactionReport } from "@station/contracts";

export const REDACTION_POLICY_VERSION = "station-redaction-v1";
export const REDACTED_VALUE = "[REDACTED]";

export type RedactionResult<T> = {
  value: T;
  report: RedactionReport;
};

type MutableRedactionReport = {
  policyVersion: string;
  generatedAt: string;
  redactedFields: Set<string>;
  redactedPatterns: Set<string>;
  replacements: number;
  suspiciousSecretsFound: number;
};

const SECRET_KEY_PATTERN =
  /(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|auth|credential|private[_-]?key|session[_-]?cookie)/i;

const SECRET_VALUE_PATTERNS: Array<[string, RegExp]> = [
  ["bearer-token", /Bearer\s+[A-Za-z0-9._~+/=-]+/gi],
  ["github-token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}\b/g],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{12,}\b/g],
  ["env-secret", /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*=([^\s]+)/g],
  ["long-secret", /\b[A-Za-z0-9+/=]{40,}\b/g],
];

export function redact<T>(input: T, now = new Date()): RedactionResult<T> {
  const mutable: MutableRedactionReport = {
    policyVersion: REDACTION_POLICY_VERSION,
    generatedAt: now.toISOString(),
    redactedFields: new Set<string>(),
    redactedPatterns: new Set<string>(),
    replacements: 0,
    suspiciousSecretsFound: 0,
  };

  return {
    value: redactValue(input, mutable, []) as T,
    report: finalizeReport(mutable),
  };
}

export function mergeRedactionReports(
  reports: readonly RedactionReport[],
  generatedAt = new Date().toISOString(),
): RedactionReport {
  const fields = new Set<string>();
  const patterns = new Set<string>();
  let replacements = 0;
  let suspiciousSecretsFound = 0;

  for (const report of reports) {
    for (const field of report.redactedFields) {
      fields.add(field);
    }
    for (const pattern of report.redactedPatterns) {
      patterns.add(pattern);
    }
    replacements += report.replacements;
    suspiciousSecretsFound += report.suspiciousSecretsFound;
  }

  return {
    policyVersion: REDACTION_POLICY_VERSION,
    generatedAt,
    redactedFields: [...fields].sort(),
    redactedPatterns: [...patterns].sort(),
    replacements,
    suspiciousSecretsFound,
  };
}

export function redactString(value: string, report?: RedactionReport): string {
  const mutable: MutableRedactionReport = reportToMutable(report);
  return redactStringInternal(value, mutable);
}

function redactValue(
  value: unknown,
  report: MutableRedactionReport,
  path: readonly string[],
): unknown {
  if (typeof value === "string") {
    return redactStringInternal(value, report);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, report, [...path, String(index)]));
  }

  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    // Key-based matches redact the whole field; value patterns preserve surrounding text.
    if (SECRET_KEY_PATTERN.test(key)) {
      report.redactedFields.add(childPath.join("."));
      report.replacements += 1;
      report.suspiciousSecretsFound += 1;
      result[key] = REDACTED_VALUE;
      continue;
    }

    result[key] = redactValue(child, report, childPath);
  }
  return result;
}

function redactStringInternal(value: string, report: MutableRedactionReport): string {
  let redacted = value;
  for (const [name, pattern] of SECRET_VALUE_PATTERNS) {
    // Each regex has global state; replace() advances it while recording every match.
    redacted = redacted.replace(pattern, (match) => {
      report.redactedPatterns.add(name);
      report.replacements += 1;
      report.suspiciousSecretsFound += 1;
      if (name === "env-secret") {
        const key = match.split("=")[0];
        return `${key}=${REDACTED_VALUE}`;
      }
      if (name === "bearer-token") {
        return `Bearer ${REDACTED_VALUE}`;
      }
      return REDACTED_VALUE;
    });
  }
  return redacted;
}

function finalizeReport(report: MutableRedactionReport): RedactionReport {
  return {
    policyVersion: report.policyVersion,
    generatedAt: report.generatedAt,
    redactedFields: [...report.redactedFields].sort(),
    redactedPatterns: [...report.redactedPatterns].sort(),
    replacements: report.replacements,
    suspiciousSecretsFound: report.suspiciousSecretsFound,
  };
}

function reportToMutable(report: RedactionReport | undefined): MutableRedactionReport {
  return {
    policyVersion: REDACTION_POLICY_VERSION,
    generatedAt: report?.generatedAt ?? new Date().toISOString(),
    redactedFields: new Set(report?.redactedFields ?? []),
    redactedPatterns: new Set(report?.redactedPatterns ?? []),
    replacements: report?.replacements ?? 0,
    suspiciousSecretsFound: report?.suspiciousSecretsFound ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
