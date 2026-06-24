import { DiagnosticEvidenceIndexSchema } from "@station/contracts";

export type DiagnosticOracleResult = {
  rootCause: string;
  confidence: "high" | "medium" | "low";
  evidenceItemIds: string[];
};

const priority = [
  "INVALID_CONFIG",
  "MISSING_WORKTRUNK_BINARY",
  "STALE_TERMINAL_TARGET",
  "HOOK_SPOOL_FALLBACK",
  "PROVIDER_TIMEOUT",
  "HARNESS_UNEXPECTED_EXIT",
  "SQLITE_WRITE_FAILURE",
  "COMMAND_FAILED",
  "PROVIDER_UNAVAILABLE",
];

export function classifyDiagnosticEvidenceIndex(input: unknown): DiagnosticOracleResult {
  const index = DiagnosticEvidenceIndexSchema.parse(input);
  const rootCauses = [...index.rootCauses].sort(
    (left, right) => priorityIndex(left.code) - priorityIndex(right.code),
  );
  const first = rootCauses[0];
  if (first !== undefined) {
    return {
      rootCause: first.code,
      confidence: first.confidence,
      evidenceItemIds: first.itemIds,
    };
  }

  const summaryCode = index.summary.rootCauseCodes[0];
  if (summaryCode !== undefined) {
    return {
      rootCause: summaryCode,
      confidence: "medium",
      evidenceItemIds: [],
    };
  }

  return {
    rootCause: "UNKNOWN",
    confidence: "low",
    evidenceItemIds: [],
  };
}

function priorityIndex(code: string): number {
  const index = priority.indexOf(code);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
