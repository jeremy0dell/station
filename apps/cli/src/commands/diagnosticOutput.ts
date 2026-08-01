import type { DoctorCheck, DoctorReport, SafeError } from "@station/contracts";

export type DoctorFinding = {
  source: "check" | "config" | "provider";
  name: string;
  severity: "error" | "warn";
  code?: string;
  message: string;
  hint?: string;
  provider?: string;
  traceId?: string;
  commandId?: string;
  diagnosticId?: string;
};

export type DoctorSummary = {
  schemaVersion: string;
  generatedAt: string;
  status: DoctorReport["status"];
  findings: DoctorFinding[];
  counts: {
    checks: { ok: number; warn: number; error: number };
    providers: { healthy: number; degraded: number; unavailable: number; unknown: number };
    projects: number;
    sessions: number;
    historicalErrors: number;
  };
  nextCommands: string[];
  truncation: {
    findings: boolean;
    text: boolean;
    totalFindings: number;
  };
  detailsCommand: string;
};

export type DoctorSummaryOptions = {
  projectId?: string;
};

const maxFindings = 5;
const maxTextCodePoints = 240;

export function buildDoctorSummary(
  report: DoctorReport,
  options: DoctorSummaryOptions = {},
): DoctorSummary {
  let textTruncated = false;
  const bound = (value: string): string => {
    const bounded = boundText(value);
    textTruncated ||= bounded.truncated;
    return bounded.value;
  };
  const findings = collectFindings(report)
    .sort(compareFinding)
    .map((finding) => boundedFinding(finding, bound));
  const retained = findings.slice(0, maxFindings);

  return {
    schemaVersion: report.schemaVersion,
    generatedAt: report.generatedAt,
    status: report.status,
    findings: retained,
    counts: {
      checks: countChecks(report.checks),
      providers: countProviders(report),
      projects: report.snapshot.counts.projects,
      sessions: report.snapshot.counts.sessions,
      historicalErrors: report.recentErrors.length,
    },
    nextCommands: nextCommands(retained),
    truncation: {
      findings: findings.length > retained.length,
      text: textTruncated,
      totalFindings: findings.length,
    },
    detailsCommand:
      options.projectId === undefined
        ? "stn doctor --full"
        : `stn doctor --project ${options.projectId} --full`,
  };
}

function collectFindings(report: DoctorReport): DoctorFinding[] {
  const configSeverity = report.checks.find((check) => check.name === "config")?.status ?? "warn";
  const configFindings = report.config.diagnostics.map((error) =>
    findingFromError("config", error.code, severity(configSeverity), error),
  );
  const providerFindings = Object.entries(report.providers)
    .filter(([, health]) => health.status === "degraded" || health.status === "unavailable")
    .map(([provider, health]) => {
      if (health.lastError !== undefined) {
        return findingFromError(
          "provider",
          provider,
          health.status === "unavailable" ? "error" : "warn",
          health.lastError,
          provider,
        );
      }
      return {
        source: "provider" as const,
        name: provider,
        severity: health.status === "unavailable" ? ("error" as const) : ("warn" as const),
        message: `${provider} is ${health.status}.`,
        provider,
      };
    });
  const providerIds = Object.keys(report.providers);
  const checkFindings = report.checks
    .filter((check) => check.status !== "ok")
    .filter((check) => check.name !== "config" || configFindings.length === 0)
    .filter((check) => check.name !== "providers" || providerFindings.length === 0)
    .map((check) => findingFromCheck(check, providerIds));
  const specificCheckFindings = checkFindings.filter((finding) => finding.name !== "observer");
  const observerFindings = checkFindings.filter((finding) => finding.name === "observer");

  return deduplicateFindings([
    ...configFindings,
    ...providerFindings,
    ...specificCheckFindings,
    ...(configFindings.length + providerFindings.length + specificCheckFindings.length === 0
      ? observerFindings
      : []),
  ]);
}

function findingFromCheck(check: DoctorCheck, providerIds: readonly string[]): DoctorFinding {
  const provider =
    check.error?.provider ??
    providerIds.find(
      (candidate) =>
        check.name === candidate ||
        check.name.startsWith(`${candidate}.`) ||
        check.name.startsWith(`${candidate}-`),
    );
  const source = provider === undefined ? "check" : "provider";
  if (check.error !== undefined) {
    return findingFromError(source, check.name, severity(check.status), check.error, provider);
  }
  return {
    source,
    name: check.name,
    severity: severity(check.status),
    message: check.message,
    ...(provider === undefined ? {} : { provider }),
  };
}

function findingFromError(
  source: DoctorFinding["source"],
  name: string,
  findingSeverity: DoctorFinding["severity"],
  error: SafeError,
  providerOverride?: string,
): DoctorFinding {
  const finding: DoctorFinding = {
    source,
    name,
    severity: findingSeverity,
    code: error.code,
    message: error.message,
  };
  if (error.hint !== undefined) finding.hint = error.hint;
  const provider = error.provider ?? providerOverride;
  if (provider !== undefined) finding.provider = provider;
  if (error.traceId !== undefined) finding.traceId = error.traceId;
  if (error.commandId !== undefined) finding.commandId = error.commandId;
  if (error.diagnosticId !== undefined) finding.diagnosticId = error.diagnosticId;
  return finding;
}

function boundedFinding(finding: DoctorFinding, bound: (value: string) => string): DoctorFinding {
  return {
    ...finding,
    message: bound(finding.message),
    ...(finding.hint === undefined ? {} : { hint: bound(finding.hint) }),
  };
}

function boundText(value: string): { value: string; truncated: boolean } {
  const codePoints = [...value];
  if (codePoints.length <= maxTextCodePoints) return { value, truncated: false };
  return {
    value: `${codePoints.slice(0, maxTextCodePoints - 1).join("")}…`,
    truncated: true,
  };
}

function severity(status: DoctorCheck["status"]): DoctorFinding["severity"] {
  return status === "error" ? "error" : "warn";
}

function compareFinding(left: DoctorFinding, right: DoctorFinding): number {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    left.source.localeCompare(right.source) ||
    left.name.localeCompare(right.name) ||
    (left.code ?? "").localeCompare(right.code ?? "") ||
    left.message.localeCompare(right.message)
  );
}

function severityRank(value: DoctorFinding["severity"]): number {
  return value === "error" ? 0 : 1;
}

function deduplicateFindings(findings: readonly DoctorFinding[]): DoctorFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = [finding.source, finding.name, finding.code, finding.message].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countChecks(checks: readonly DoctorCheck[]): DoctorSummary["counts"]["checks"] {
  const counts = { ok: 0, warn: 0, error: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

function countProviders(report: DoctorReport): DoctorSummary["counts"]["providers"] {
  const counts = { healthy: 0, degraded: 0, unavailable: 0, unknown: 0 };
  for (const provider of Object.values(report.providers)) counts[provider.status] += 1;
  return counts;
}

function nextCommands(findings: readonly DoctorFinding[]): string[] {
  const commands = new Set<string>();
  for (const finding of findings) {
    if (finding.traceId !== undefined) commands.add(`stn debug trace ${finding.traceId}`);
    else if (finding.commandId !== undefined) commands.add(`stn command get ${finding.commandId}`);
    else if (finding.diagnosticId !== undefined) {
      commands.add(`stn debug trace ${finding.diagnosticId}`);
    }
    if (commands.size === 3) break;
  }
  return [...commands];
}
