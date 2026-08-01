import type { LogRecord } from "@station/contracts";

export type CauseAssessmentStatus =
  | "explicit_root_cause"
  | "observed_failure"
  | "matched_success"
  | "insufficient_evidence";

export type CauseAssessmentLimitation =
  | "no_explicit_root_cause"
  | "reporting_boundary_only"
  | "incomplete_search"
  | "invalid_evidence";

export type CauseAssessment = {
  status: CauseAssessmentStatus;
  explicitRootCauseCodes: string[];
  observedFailureCodes: string[];
  observedFailureSignals?: string[];
  limitations: CauseAssessmentLimitation[];
};

export type DiagnosticMatchEvidence = {
  path: string;
  excerpt: string;
};

export type DiagnosticContextEntry = {
  path: string;
  value: string | number | boolean | null;
};

export type OperationalBoundaryEvidence = {
  operation?: string;
  commandType?: string;
  signalKind?: string;
  recordSummary?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type DiagnosticEvidenceRoles = {
  operationalBoundaryEvidence: "failure_and_ownership_evidence";
  component: "logging_location_only";
};

const maxMatchEvidence = 3;
const maxExcerptCodePoints = 160;
const maxContextEntries = 6;
const maxContextStringCodePoints = 120;
const maxOperationalTextCodePoints = 240;
// attributes.kind also classifies normal hook events, so only retained corruption kinds establish failure signals.
const observedFailureSignalKinds = new Set([
  "escape_fragment",
  "replacement_char",
  "unhandled_sequence",
]);
const duplicatedAttributeKeys = new Set([
  "commandId",
  "error",
  "projectId",
  "provider",
  "sessionId",
  "spanId",
  "startupTail",
  "traceId",
  "worktreeId",
]);

export function assessCauseEvidence(input: {
  explicitRootCauseCodes: readonly string[];
  observedFailureCodes: readonly string[];
  observedFailureSignals?: readonly string[];
  observedFailureRecord?: boolean;
  matched: boolean;
  commandStatus?: string;
  searchComplete: boolean;
  invalidLines: number;
  reportingBoundaryOnly: boolean;
}): CauseAssessment {
  const explicitRootCauseCodes = uniqueSorted(input.explicitRootCauseCodes);
  const observedFailureCodes = uniqueSorted(input.observedFailureCodes);
  const observedFailureSignals = uniqueSorted(input.observedFailureSignals ?? []);
  // Only diagnostic-index root-cause declarations authorize this status; an error code is evidence of a failure, not proof of its underlying cause.
  // An exactly matched warning or error record establishes its retained event as a proximate failure without establishing a deeper mechanism.
  let status: CauseAssessmentStatus = "insufficient_evidence";
  if (explicitRootCauseCodes.length > 0) {
    status = "explicit_root_cause";
  } else if (input.commandStatus === "succeeded") {
    status = "matched_success";
  } else if (
    observedFailureCodes.length > 0 ||
    observedFailureSignals.length > 0 ||
    input.observedFailureRecord === true
  ) {
    status = "observed_failure";
  }
  const limitations: CauseAssessmentLimitation[] = [];
  if (status === "observed_failure" || status === "insufficient_evidence") {
    limitations.push("no_explicit_root_cause");
  }
  if (input.reportingBoundaryOnly) limitations.push("reporting_boundary_only");
  if (!input.searchComplete) limitations.push("incomplete_search");
  if (input.invalidLines > 0) limitations.push("invalid_evidence");
  const assessment: CauseAssessment = {
    status,
    explicitRootCauseCodes,
    observedFailureCodes,
    limitations,
  };
  if (observedFailureSignals.length > 0) {
    assessment.observedFailureSignals = observedFailureSignals;
  }
  return assessment;
}

export function extractDiagnosticMatchEvidence(
  record: LogRecord,
  query: string,
): DiagnosticMatchEvidence[] {
  const normalizedQuery = query.toLocaleLowerCase();
  if (normalizedQuery.length === 0) return [];
  const matches: DiagnosticMatchEvidence[] = [];
  const matchedPaths = new Set<string>();

  // LogRecord has already crossed strict parsing and redaction; this generic traversal only projects bounded excerpts from that safe representation.
  visit(record, "", (path, key, value) => {
    if (matches.length >= maxMatchEvidence) return;
    const scalar = scalarText(value);
    const keyMatches = key.toLocaleLowerCase().includes(normalizedQuery);
    const valueMatches = scalar?.toLocaleLowerCase().includes(normalizedQuery) === true;
    if (!keyMatches && !valueMatches) return;
    const evidencePath = path.length === 0 ? "/" : path;
    if (matchedPaths.has(evidencePath)) return;
    matchedPaths.add(evidencePath);
    const source = keyMatches && scalar !== undefined ? `${key}: ${scalar}` : (scalar ?? key);
    matches.push({
      path: evidencePath,
      excerpt: boundedExcerpt(source, normalizedQuery),
    });
  });
  return matches;
}

export function projectDiagnosticContext(record: LogRecord): DiagnosticContextEntry[] {
  const attributes = record.attributes;
  if (attributes === undefined) return [];
  const context: DiagnosticContextEntry[] = [];
  for (const key of Object.keys(attributes).sort((left, right) => left.localeCompare(right))) {
    if (context.length >= maxContextEntries) break;
    if (duplicatedAttributeKeys.has(key)) continue;
    const value = scalarValue(attributes[key]);
    if (value === undefined) continue;
    if (typeof value === "string" && [...value].length > maxContextStringCodePoints) continue;
    context.push({ path: `/attributes/${escapePointerToken(key)}`, value });
  }
  return context;
}

export function diagnosticEvidenceRoles(): DiagnosticEvidenceRoles {
  return {
    operationalBoundaryEvidence: "failure_and_ownership_evidence",
    component: "logging_location_only",
  };
}

export function retainedFailureSignal(kind: string | undefined): string | undefined {
  return kind !== undefined && observedFailureSignalKinds.has(kind) ? kind : undefined;
}

// Keep this projection to retained facts so CLI presentation never invents subsystem ownership.
export function projectOperationalBoundaryEvidence(input: {
  operation?: string;
  commandType?: string;
  signalKind?: string;
  recordSummary?: string;
  errorCode?: string;
  errorMessage?: string;
}): OperationalBoundaryEvidence | undefined {
  const evidence: OperationalBoundaryEvidence = {};
  if (input.operation !== undefined) evidence.operation = boundedOperationalText(input.operation);
  if (input.commandType !== undefined) {
    evidence.commandType = boundedOperationalText(input.commandType);
  }
  if (input.signalKind !== undefined) {
    evidence.signalKind = boundedOperationalText(input.signalKind);
  }
  if (input.recordSummary !== undefined) {
    evidence.recordSummary = boundedOperationalText(input.recordSummary);
  }
  if (input.errorCode !== undefined) evidence.errorCode = boundedOperationalText(input.errorCode);
  if (input.errorMessage !== undefined) {
    evidence.errorMessage = boundedOperationalText(input.errorMessage);
  }
  return Object.keys(evidence).length === 0 ? undefined : evidence;
}

function visit(
  value: unknown,
  path: string,
  onScalar: (path: string, key: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const itemPath = `${path}/${index}`;
      if (isContainer(item)) visit(item, itemPath, onScalar);
      else onScalar(itemPath, String(index), item);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    const item = (value as Record<string, unknown>)[key];
    const itemPath = `${path}/${escapePointerToken(key)}`;
    if (isContainer(item)) visit(item, itemPath, onScalar);
    else onScalar(itemPath, key, item);
  }
}

function isContainer(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function scalarText(value: unknown): string | undefined {
  const scalar = scalarValue(value);
  return scalar === undefined ? undefined : String(scalar);
}

function scalarValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function boundedOperationalText(value: string): string {
  const codePoints = [...value];
  return codePoints.length <= maxOperationalTextCodePoints
    ? value
    : `${codePoints.slice(0, maxOperationalTextCodePoints - 1).join("")}…`;
}

function boundedExcerpt(value: string, normalizedQuery: string): string {
  const codePoints = [...value];
  if (codePoints.length <= maxExcerptCodePoints) return value;
  const lower = value.toLocaleLowerCase();
  const matchIndex = lower.indexOf(normalizedQuery);
  const prefix = matchIndex < 0 ? 0 : [...value.slice(0, matchIndex)].length;
  const halfWindow = Math.floor(maxExcerptCodePoints / 2);
  const proposedStart = Math.max(
    0,
    Math.min(prefix - halfWindow, codePoints.length - maxExcerptCodePoints),
  );
  const prefixMarker = proposedStart > 0 ? "…" : "";
  const available = maxExcerptCodePoints - [...prefixMarker].length - 1;
  const end = Math.min(codePoints.length, proposedStart + available);
  const suffixMarker = end < codePoints.length ? "…" : "";
  const excerpt = codePoints
    .slice(proposedStart, end + (suffixMarker.length === 0 ? 1 : 0))
    .join("");
  return `${prefixMarker}${excerpt}${suffixMarker}`;
}

function escapePointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
