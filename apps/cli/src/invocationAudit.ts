import type { CurrentSessionContext } from "@station/contracts";
import {
  type CliInvocationArgumentShape,
  type CliInvocationBuildEvidence,
  type CliInvocationEffect,
  type CliInvocationErrorSummary,
  CliInvocationErrorSummaryProjectionInputSchema,
  CliInvocationErrorSummarySchema,
  type CliInvocationId,
  type CliInvocationOutcome,
  CliInvocationOutcomeSchema,
  type CliInvocationSinkEvidence,
  type CliInvocationStart,
  CliInvocationStartSchema,
  type CliInvocationTerminalStatus,
  type CliRunAuditMetadata,
  CliRunAuditMetadataSchema,
  CurrentSessionContextSchema,
  type LogRecord,
  LogRecordSchema,
  type RetentionPolicy,
} from "@station/contracts";
import {
  allowlistedCliRunAuditMetadata,
  appendDurableCliInvocationRecord,
  type DurableCliInvocationAppendResult,
} from "@station/observability";
import type { StationBuildInfo } from "@station/runtime";
import { isSafeError } from "@station/runtime";
import { isCliInputError } from "./args.js";

export const CLI_INVOCATION_AUDIT_WARNING =
  "Warning: CLI invocation audit is unavailable; this invocation is not fully audited.\n";
export const CLI_INVOCATION_MUTATION_BLOCKED_WARNING =
  "Warning: mutation refused because the CLI invocation start record was not durable.\n";
export const CLI_INVOCATION_OUTCOME_UNCERTAIN_WARNING =
  "Warning: the CLI invocation outcome was not durable; the effect or accepted dispatch may already have completed.\n";

export type CliInvocationWriteResult = {
  attempted: boolean;
  durable: boolean;
  cleanupDegraded: boolean;
};

export type CliInvocationAuditLifecycle = {
  start(
    input: Omit<CliInvocationStart, "kind" | "invocationId" | "startedAt">,
  ): Promise<CliInvocationWriteResult>;
  outcome(
    input: Omit<CliInvocationOutcome, "kind" | "invocationId" | "finishedAt" | "durationMs">,
  ): Promise<CliInvocationWriteResult>;
};

export type CreateCliInvocationAuditLifecycleOptions = {
  invocationId: CliInvocationId;
  startedAt: Date;
  stateDir: string;
  policy: RetentionPolicy;
  clock?: { now(): Date };
  appendRecord?: (options: {
    stateDir: string;
    policy: RetentionPolicy;
    record: LogRecord;
    now?: Date;
  }) => Promise<DurableCliInvocationAppendResult>;
};

/**
 * ADAPTER
 *
 * Persists one strict CLI invocation start and outcome in process order while keeping the
 * Observer command journal authoritative for execution state.
 */
export function createCliInvocationAuditLifecycle(
  options: CreateCliInvocationAuditLifecycleOptions,
): CliInvocationAuditLifecycle {
  const clock = options.clock ?? { now: () => new Date() };
  const appendRecord = options.appendRecord ?? appendDurableCliInvocationRecord;
  let startAttempted = false;
  let outcomeAttempted = false;

  async function append(lifecycle: CliInvocationStart | CliInvocationOutcome) {
    const record = lifecycleLogRecord(lifecycle);
    try {
      const result = await appendRecord({
        stateDir: options.stateDir,
        policy: options.policy,
        record,
        now: new Date(record.timestamp),
      });
      return {
        attempted: true,
        durable: true,
        cleanupDegraded: result.cleanupFailures > 0,
      };
    } catch {
      return { attempted: true, durable: false, cleanupDegraded: false };
    }
  }

  return {
    start: async (input) => {
      if (startAttempted) {
        return { attempted: false, durable: false, cleanupDegraded: false };
      }
      startAttempted = true;
      const lifecycle = CliInvocationStartSchema.parse({
        ...input,
        kind: "start",
        invocationId: options.invocationId,
        startedAt: options.startedAt.toISOString(),
      });
      return append(lifecycle);
    },
    outcome: async (input) => {
      if (outcomeAttempted) {
        return { attempted: false, durable: false, cleanupDegraded: false };
      }
      outcomeAttempted = true;
      const finishedAt = clock.now();
      const lifecycle = CliInvocationOutcomeSchema.parse({
        ...input,
        kind: "outcome",
        invocationId: options.invocationId,
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - options.startedAt.getTime()),
      });
      return append(lifecycle);
    },
  };
}

export function cliInvocationBuildEvidence(
  buildInfo: StationBuildInfo | undefined,
): CliInvocationBuildEvidence {
  return buildInfo === undefined
    ? { status: "unavailable" }
    : {
        status: "available",
        version: buildInfo.version,
        compiled: buildInfo.compiled,
        buildIdentity: buildInfo.buildIdentity,
      };
}

export function buildCliInvocationArgumentShape(
  args: readonly string[],
): CliInvocationArgumentShape {
  const recognizedOptions: string[] = [];
  let positionalCount = 0;
  for (const arg of args) {
    const option = cliOptionName(arg);
    if (option === undefined) {
      positionalCount += 1;
      continue;
    }
    if (
      recognizedCliInvocationOptions.has(option) &&
      !recognizedOptions.includes(option) &&
      recognizedOptions.length < 32
    ) {
      recognizedOptions.push(option);
    }
  }
  return {
    argumentCount: args.length,
    positionalCount,
    recognizedOptions,
    stdinRequested: recognizedOptions.includes("--stdin"),
  };
}

export function classifyCliInvocationEffect(
  resolvedPath: readonly string[],
  args: readonly string[],
): CliInvocationEffect {
  const path = resolvedPath.join(" ");
  if (path === "host handoff") return args.includes("--dry-run") ? "read" : "mutation";
  if (path === "observer reap") return args.includes("--force") ? "mutation" : "read";
  if (path === "setup apply") return args.includes("--dry-run") ? "read" : "mutation";
  if (path === "setup system") return args.includes("--check") ? "read" : "mutation";
  if (path === "update") return args.includes("--dry-run") ? "read" : "mutation";
  const classified = CLI_INVOCATION_STATIC_EFFECTS[path];
  if (classified !== undefined) return classified;
  if (resolvedPath.length === 0) return "none";
  return "mutation";
}

const CLI_INVOCATION_STATIC_EFFECTS: Readonly<Record<string, CliInvocationEffect>> = {
  command: "mutation",
  "command dispatch": "mutation",
  "command get": "read",
  debug: "mutation",
  "debug bundle": "mutation",
  "debug logs": "recovery",
  "debug trace": "recovery",
  doctor: "recovery",
  "event-hooks": "mutation",
  "event-hooks doctor": "read",
  "event-hooks install": "mutation",
  "event-hooks plan": "read",
  hooks: "mutation",
  "hooks doctor": "read",
  "hooks install": "mutation",
  "hooks plan": "read",
  "hooks reconcile": "mutation",
  "hooks uninstall": "mutation",
  host: "mutation",
  "host status": "read",
  notify: "mutation",
  "notify agent-state": "mutation",
  observe: "read",
  observer: "mutation",
  "observer ensure-exact-build": "mutation",
  "observer restart": "mutation",
  "observer start": "mutation",
  "observer status": "read",
  "observer stop": "mutation",
  popup: "mutation",
  project: "mutation",
  "project add": "mutation",
  "project doctor": "read",
  "project list": "read",
  "project remove": "mutation",
  reconcile: "mutation",
  session: "mutation",
  "session close": "mutation",
  "session current": "read",
  "session get": "read",
  "session list": "read",
  "session rename": "mutation",
  setup: "mutation",
  "setup check": "read",
  "setup plan": "read",
  snapshot: "read",
  tui: "mutation",
  worktrunk: "mutation",
  "worktrunk hooks": "mutation",
  "worktrunk hooks doctor": "read",
  "worktrunk hooks install": "mutation",
  "worktrunk hooks plan": "read",
  "worktrunk hooks uninstall": "mutation",
};

const conditionalCliInvocationPaths = new Set([
  "host handoff",
  "observer reap",
  "setup apply",
  "setup system",
  "update",
]);

const recognizedCliInvocationOptions = new Set([
  "-h",
  "--agent",
  "--all-components",
  "--allow-nested",
  "--allow-non-git",
  "--channel",
  "--check",
  "--command",
  "--component",
  "--config",
  "--deep",
  "--delivery-timeout-ms",
  "--dev-fake-dashboard",
  "--drive-package-manager",
  "--dry-run",
  "--duration",
  "--failed",
  "--fidelity",
  "--force",
  "--handoff",
  "--help",
  "--hook-bin",
  "--id",
  "--include-debug",
  "--include-snapshot",
  "--json",
  "--label",
  "--last",
  "--latest-failure",
  "--limit",
  "--man",
  "--min-level",
  "--no-auto-start",
  "--no-brew",
  "--no-handoff",
  "--observer-entry",
  "--opencode-config-dir",
  "--pane",
  "--persistent",
  "--popup",
  "--project",
  "--rate-limit-ms",
  "--reap",
  "--reason",
  "--require-running",
  "--since",
  "--socket",
  "--spool-dir",
  "--startup-timeout-ms",
  "--state-dir",
  "--stdin",
  "--takeover",
  "--timeout-ms",
  "--trace",
  "--type",
  "--version",
  "--wait",
  "--worktrunk-config",
  "--yes",
]);

export function hasExplicitCliInvocationEffectPolicy(path: readonly string[]): boolean {
  const key = path.join(" ");
  return CLI_INVOCATION_STATIC_EFFECTS[key] !== undefined || conditionalCliInvocationPaths.has(key);
}

export function projectCurrentSessionAuditMetadata(
  input: unknown,
): CliRunAuditMetadata | undefined {
  const parsed = CurrentSessionContextSchema.safeParse(input);
  if (!parsed.success) return undefined;
  return allowlistedCliRunAuditMetadata(currentSessionAudit(parsed.data));
}

export function cliInvocationErrorSummary(error: unknown): CliInvocationErrorSummary | undefined {
  if (isSafeError(error)) {
    return allowlistedErrorSummary(error);
  }
  if (isCliInputError(error)) {
    return cliInvocationErrorSummaryFromTagAndCode(error.tag, error.code);
  }
  const tagged = CliInvocationErrorSummaryProjectionInputSchema.safeParse(error);
  if (tagged.success) {
    const summary = CliInvocationErrorSummarySchema.safeParse({
      tag: tagged.data.tag,
      code: tagged.data.code,
    });
    if (summary.success) return summary.data;
  }
  return undefined;
}

export function terminalStatusForResult(input: {
  help: boolean;
  version: boolean;
  recovery: boolean;
  code: number;
  audit?: CliRunAuditMetadata;
}): CliInvocationTerminalStatus {
  if (input.help) return "help";
  if (input.version) return "version";
  if (input.recovery) return "diagnostic_recovery";
  if (input.audit?.commandStatus === "rejected") return "rejected";
  if (input.audit?.commandStatus === "failed") return "failed";
  return input.code === 0 ? "succeeded" : "failed";
}

function lifecycleLogRecord(lifecycle: CliInvocationStart | CliInvocationOutcome): LogRecord {
  const record: Record<string, unknown> = {
    timestamp: lifecycle.kind === "start" ? lifecycle.startedAt : lifecycle.finishedAt,
    level: lifecycle.kind === "outcome" && lifecycle.exitCode !== 0 ? "warn" : "info",
    component: "cli",
    message: lifecycle.kind === "start" ? "cli.invocation.start" : "cli.invocation.outcome",
    invocationId: lifecycle.invocationId,
    cliInvocation: lifecycle,
  };
  if (lifecycle.kind === "outcome" && lifecycle.audit !== undefined) {
    mirrorAudit(record, lifecycle.audit);
  }
  return LogRecordSchema.parse(record);
}

function mirrorAudit(record: Record<string, unknown>, audit: CliRunAuditMetadata): void {
  const commandId = audit.command?.commandId ?? audit.error?.commandId;
  const traceId = audit.command?.traceId ?? audit.error?.traceId;
  if (commandId !== undefined) record.commandId = commandId;
  if (traceId !== undefined) record.traceId = traceId;
  if (audit.error?.diagnosticId !== undefined) record.diagnosticId = audit.error.diagnosticId;
  const projectId = audit.resources?.projectId ?? audit.error?.projectId;
  const worktreeId = audit.resources?.worktreeId ?? audit.error?.worktreeId;
  const sessionId = audit.resources?.sessionId ?? audit.error?.sessionId;
  const provider =
    audit.resources?.provider ?? audit.placement?.resolved?.provider ?? audit.error?.provider;
  if (projectId !== undefined) record.projectId = projectId;
  if (worktreeId !== undefined) record.worktreeId = worktreeId;
  if (sessionId !== undefined) record.sessionId = sessionId;
  if (provider !== undefined) record.provider = provider;
}

function currentSessionAudit(context: CurrentSessionContext): CliRunAuditMetadata {
  const metadata: CliRunAuditMetadata = {
    callerContext: { presentation: context.presentation },
  };
  if (context.session !== undefined) {
    const session: NonNullable<NonNullable<CliRunAuditMetadata["callerContext"]>["session"]> = {
      sessionId: context.session.id,
      projectId: context.session.projectId,
      worktreeId: context.session.worktreeId,
    };
    if (context.session.group !== undefined) session.groupId = context.session.group.id;
    metadata.callerContext = { presentation: context.presentation, session };
    metadata.resources = {
      sessionId: context.session.id,
      projectId: context.session.projectId,
      worktreeId: context.session.worktreeId,
    };
  }
  return metadata;
}

function allowlistedErrorSummary(error: {
  tag: string;
  code: string;
  commandId?: string | undefined;
  traceId?: string | undefined;
  diagnosticId?: string | undefined;
  projectId?: string | undefined;
  worktreeId?: string | undefined;
  sessionId?: string | undefined;
  provider?: string | undefined;
}): CliInvocationErrorSummary | undefined {
  const candidate: Record<string, unknown> = { tag: error.tag, code: error.code };
  for (const field of [
    "commandId",
    "traceId",
    "diagnosticId",
    "projectId",
    "worktreeId",
    "sessionId",
    "provider",
  ] as const) {
    if (error[field] !== undefined) candidate[field] = error[field];
  }
  const parsed = CliRunAuditMetadataSchema.safeParse({ error: candidate });
  return parsed.success ? parsed.data.error : undefined;
}

function cliInvocationErrorSummaryFromTagAndCode(
  tag: string,
  code: string,
): CliInvocationErrorSummary | undefined {
  const parsed = CliRunAuditMetadataSchema.safeParse({ error: { tag, code } });
  return parsed.success ? parsed.data.error : undefined;
}

function cliOptionName(arg: string): string | undefined {
  const separator = arg.indexOf("=");
  const candidate = separator === -1 ? arg : arg.slice(0, separator);
  return /^--?[a-z][a-z0-9-]{0,63}$/u.test(candidate) ? candidate : undefined;
}

export function auditSinkEvidence(input: {
  explicitConfig: boolean;
  configured: boolean;
  missingDefaultConfig: boolean;
}): CliInvocationSinkEvidence {
  if (input.configured) {
    return {
      source: "configured",
      configResolution: input.explicitConfig ? "explicit" : "default",
    };
  }
  return {
    source: "bootstrap_default",
    configResolution: input.explicitConfig ? "explicit" : "default",
    fallbackReason: input.missingDefaultConfig ? "missing_default_config" : "config_load_failed",
  };
}
