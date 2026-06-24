import type {
  DiagnosticEvidenceIndex,
  DiagnosticEvidenceItem,
  DiagnosticRootCause,
  DiagnosticRootCauseCode,
  DiagnosticSnapshot,
} from "@station/contracts";
import { DiagnosticEvidenceIndexSchema, STATION_SCHEMA_VERSION } from "@station/contracts";

export type BuildDiagnosticEvidenceIndexOptions = {
  generatedAt?: Date | string | undefined;
  bundleId?: string | undefined;
  redaction?: "redacted" | "unknown" | undefined;
};

type EvidenceErrorSource = {
  tag?: string | undefined;
  code?: string | undefined;
  message?: string | undefined;
  hint?: string | undefined;
  commandId?: string | undefined;
  projectId?: string | undefined;
  worktreeId?: string | undefined;
  sessionId?: string | undefined;
  provider?: string | undefined;
  traceId?: string | undefined;
  spanId?: string | undefined;
  diagnosticId?: string | undefined;
};

export function buildDiagnosticEvidenceIndex(
  snapshot: DiagnosticSnapshot,
  options: BuildDiagnosticEvidenceIndexOptions = {},
): DiagnosticEvidenceIndex {
  const builder = new EvidenceIndexBuilder(snapshot, options);
  builder.addConfigEvidence();
  builder.addObserverEvidence();
  builder.addProviderEvidence();
  builder.addCommandEvidence();
  builder.addEventEvidence();
  builder.addErrorEvidence();
  builder.addLogEvidence();
  builder.addHookSpoolEvidence();
  builder.addRowEvidence();
  return builder.build();
}

class EvidenceIndexBuilder {
  readonly #snapshot: DiagnosticSnapshot;
  readonly #options: BuildDiagnosticEvidenceIndexOptions;
  readonly #items: DiagnosticEvidenceItem[] = [];
  readonly #rootCauses = new Map<DiagnosticRootCauseCode, DiagnosticRootCause>();
  readonly #questions: DiagnosticEvidenceIndex["questions"] = [];

  constructor(snapshot: DiagnosticSnapshot, options: BuildDiagnosticEvidenceIndexOptions) {
    this.#snapshot = snapshot;
    this.#options = options;
  }

  addConfigEvidence(): void {
    for (const diagnostic of this.#snapshot.configSummary?.diagnostics ?? []) {
      const item = this.#addItem({
        id: `config-${diagnostic.diagnosticId ?? diagnostic.code}`,
        category: "config",
        severity: "error",
        code: diagnostic.code,
        message: diagnostic.message,
        source: diagnostic,
      });
      this.#addRootCause("INVALID_CONFIG", "The config could not be loaded or validated.", item);
    }
  }

  addObserverEvidence(): void {
    const health = this.#snapshot.observerHealth;
    if (health.status !== "healthy") {
      this.#addItem({
        id: "observer-health",
        category: "observer",
        severity: health.status === "unavailable" ? "error" : "warn",
        code: "OBSERVER_DEGRADED",
        message: `Observer health is ${health.status}.`,
        evidence: {
          status: health.status,
        },
      });
    }

    const sqlite = health.sqlite;
    if (sqlite !== undefined && (sqlite.status !== "healthy" || sqlite.lastError !== undefined)) {
      const item = this.#addItem({
        id: "sqlite-health",
        category: "sqlite",
        severity: sqlite.status === "healthy" ? "warn" : "error",
        code: sqlite.lastError?.code ?? "SQLITE_UNAVAILABLE",
        message: sqlite.lastError?.message ?? `SQLite is ${sqlite.status}.`,
        source: sqlite.lastError,
        evidence: {
          path: sqlite.path,
          open: sqlite.open,
          status: sqlite.status,
          schemaVersion: sqlite.schemaVersion,
        },
      });
      this.#addRootCause("SQLITE_WRITE_FAILURE", "Observer SQLite writes are failing.", item);
    }

    const reconcile = health.lastReconcile;
    if (reconcile?.errors !== undefined) {
      for (const [index, error] of reconcile.errors.entries()) {
        const item = this.#addItem({
          id: `observer-reconcile-error-${index}`,
          category: "observer",
          severity: "error",
          code: "RECONCILE_ERROR",
          message: error.message,
          source: error,
          evidence: {
            reason: reconcile.reason,
            durationMs: reconcile.durationMs,
            errorCode: error.code,
          },
        });
        this.#classifyAndAddRootCause(error, item, "observer");
      }
    }
  }

  addProviderEvidence(): void {
    for (const [providerId, health] of Object.entries(this.#snapshot.providerHealth)) {
      if (health.status === "healthy" && health.lastError === undefined) {
        continue;
      }
      const evidence: Record<string, unknown> = {
        status: health.status,
        providerType: health.providerType,
      };
      if (health.latencyMs !== undefined) {
        evidence.latencyMs = health.latencyMs;
      }
      if (health.diagnostics !== undefined) {
        evidence.diagnostics = health.diagnostics;
      }
      const item = this.#addItem({
        id: `provider-${providerId}`,
        category: "provider",
        severity: health.status === "unavailable" ? "error" : "warn",
        code: health.lastError?.code ?? "PROVIDER_UNAVAILABLE",
        message: health.lastError?.message ?? `${providerId} is ${health.status}.`,
        source: health.lastError,
        evidence,
      });
      this.#classifyAndAddRootCause(health.lastError, item, "provider");
      if (health.lastError === undefined) {
        this.#addRootCause("PROVIDER_UNAVAILABLE", `${providerId} is ${health.status}.`, item);
      }
    }
  }

  addCommandEvidence(): void {
    for (const command of this.#snapshot.commands) {
      if (command.status !== "failed") {
        continue;
      }
      const item = this.#addItem({
        id: `command-${command.id}`,
        category: "command",
        severity: "error",
        code: command.error?.code ?? "COMMAND_FAILED",
        message: command.error?.message ?? `${command.type} failed.`,
        source: command.error,
        commandId: command.id,
        traceId: command.traceId,
        spanId: command.spanId,
        evidence: {
          commandType: command.type,
          payload: command.command.payload,
        },
      });
      this.#classifyAndAddRootCause(command.error, item, "command");
    }
  }

  addEventEvidence(): void {
    for (const [index, event] of this.#snapshot.events.entries()) {
      if (event.type === "command.failed") {
        const item = this.#addItem({
          id: `event-command-failed-${event.commandId}`,
          category: "event",
          severity: "error",
          code: event.error.code,
          message: event.error.message,
          source: event.error,
          commandId: event.commandId,
          traceId: event.traceId,
          spanId: event.spanId,
        });
        this.#classifyAndAddRootCause(event.error, item, "event");
        continue;
      }

      if (event.type === "providerHook.spoolDrained" && event.failed > 0) {
        const item = this.#addItem({
          id: `event-hook-spool-drained-${index}`,
          category: "event",
          severity: "warn",
          code: "HOOK_SPOOL_DRAIN_FAILED",
          message: `Hook spool drain reported ${event.failed} failed record(s).`,
          evidence: {
            drained: event.drained,
            failed: event.failed,
          },
        });
        this.#addRootCause("HOOK_SPOOL_FALLBACK", "Hook delivery fell back to local spool.", item);
      }
    }
  }

  addErrorEvidence(): void {
    for (const error of this.#snapshot.errors) {
      const item = this.#addItem({
        id: `error-${error.id}`,
        category: "error",
        severity: error.severity,
        code: error.code,
        message: error.message,
        source: error,
        commandId: error.commandId,
        traceId: error.traceId,
        spanId: error.spanId,
        diagnosticId: error.id,
        evidence: error.diagnostics === undefined ? undefined : { diagnostics: error.diagnostics },
      });
      this.#classifyAndAddRootCause(error, item, "error");
    }
  }

  addLogEvidence(): void {
    for (const [index, log] of this.#snapshot.logs.entries()) {
      if (log.level !== "warn" && log.level !== "error") {
        continue;
      }
      const item = this.#addItem({
        id: `log-${index}`,
        category: "log",
        severity: log.level,
        code: logAttributeCode(log.attributes),
        message: log.message,
        provider: log.provider,
        commandId: log.commandId,
        traceId: log.traceId,
        spanId: log.spanId,
        projectId: log.projectId,
        worktreeId: log.worktreeId,
        sessionId: log.sessionId,
        evidence: log.attributes,
      });
      if (log.component === "hook" || log.message.toLowerCase().includes("spool")) {
        this.#addRootCause("HOOK_SPOOL_FALLBACK", "Hook delivery fell back to local spool.", item);
      }
    }
  }

  addHookSpoolEvidence(): void {
    const spool = this.#snapshot.hookSpool;
    if (spool === undefined || spool.pending === 0) {
      return;
    }
    const item = this.#addItem({
      id: "hook-spool",
      category: "hook_spool",
      severity: "warn",
      code: "HOOK_SPOOL_PENDING",
      message: `Hook spool has ${spool.pending} pending record(s).`,
      evidence: {
        path: spool.path,
        pending: spool.pending,
      },
    });
    this.#addRootCause("HOOK_SPOOL_FALLBACK", "Hook delivery fell back to local spool.", item);
    this.#questions.push({
      id: "hook-spool-status",
      question: "Are provider hooks currently spooled?",
      answer: `Hook spool has ${spool.pending} pending record(s) at ${spool.path}.`,
      itemIds: [item.id],
    });
  }

  addRowEvidence(): void {
    for (const row of this.#snapshot.snapshot.rows) {
      const evidence: Record<string, unknown> = {
        branch: row.branch,
        path: row.path,
        worktreeState: row.worktree.state,
        worktreeSource: row.worktree.source,
        statusLabel: row.display.statusLabel,
      };
      if (row.terminal !== undefined) {
        evidence.terminal = row.terminal;
      }
      if (row.agent !== undefined) {
        evidence.agent = row.agent;
      }

      const item = this.#addItem({
        id: `row-${row.id}`,
        category: "row",
        severity: row.display.alert || row.display.warning ? "warn" : "info",
        code: "ROW_PROVIDER_STATE",
        message: `Row ${row.id} is ${row.display.statusLabel}.`,
        provider: row.terminal?.provider ?? row.agent?.harness,
        projectId: row.projectId,
        worktreeId: row.id,
        runId: row.agent?.runId,
        sessionId: row.agent?.sessionId,
        evidence,
      });

      this.#addRowQuestions(row, item.id);
      if (row.terminal?.state === "stale") {
        this.#addRootCause(
          "STALE_TERMINAL_TARGET",
          "A terminal target referenced by the row is stale.",
          item,
        );
      }
      const agentReason = row.agent?.reason.toLowerCase() ?? "";
      if (row.agent?.state === "exited" && agentReason.includes("unexpected")) {
        this.#addRootCause("HARNESS_UNEXPECTED_EXIT", "Harness process exited unexpectedly.", item);
      }
    }
  }

  build(): DiagnosticEvidenceIndex {
    const rootCauses = [...this.#rootCauses.values()];
    const rootCauseCodes = rootCauses.map((cause) => cause.code).sort();
    const providers = unique(
      this.#items.flatMap((item) => (item.provider === undefined ? [] : [item.provider])),
    );
    const commandIds = unique(
      this.#items.flatMap((item) => (item.commandId === undefined ? [] : [item.commandId])),
    );
    const diagnosticIds = unique(
      this.#items.flatMap((item) => (item.diagnosticId === undefined ? [] : [item.diagnosticId])),
    );
    const source: NonNullable<DiagnosticEvidenceIndex["source"]> = {
      collectedAt: this.#snapshot.collectedAt,
    };
    if (this.#options.bundleId !== undefined) {
      source.bundleId = this.#options.bundleId;
    }
    const index: DiagnosticEvidenceIndex = {
      schemaVersion: STATION_SCHEMA_VERSION,
      generatedAt: toIso(this.#options.generatedAt ?? this.#snapshot.collectedAt),
      source,
      summary: {
        status: this.#status(rootCauseCodes),
        rootCauseCodes,
        providers,
        commandIds,
        diagnosticIds,
        redaction: this.#options.redaction ?? "unknown",
      },
      items: this.#items,
      rootCauses,
      questions: this.#questions,
    };
    return DiagnosticEvidenceIndexSchema.parse(index);
  }

  #addItem(input: AddItemInput): DiagnosticEvidenceItem {
    const item: DiagnosticEvidenceItem = {
      id: input.id,
      category: input.category,
      severity: input.severity,
      message: input.message,
    };
    if (input.code !== undefined) item.code = input.code;
    const provider = input.provider ?? input.source?.provider;
    if (provider !== undefined) item.provider = provider;
    const commandId = input.commandId ?? input.source?.commandId;
    if (commandId !== undefined) item.commandId = commandId;
    const traceId = input.traceId ?? input.source?.traceId;
    if (traceId !== undefined) item.traceId = traceId;
    if (input.spanId !== undefined) item.spanId = input.spanId;
    const projectId = input.projectId ?? input.source?.projectId;
    if (projectId !== undefined) item.projectId = projectId;
    const worktreeId = input.worktreeId ?? input.source?.worktreeId;
    if (worktreeId !== undefined) item.worktreeId = worktreeId;
    const sessionId = input.sessionId ?? input.source?.sessionId;
    if (sessionId !== undefined) item.sessionId = sessionId;
    if (input.targetId !== undefined) item.targetId = input.targetId;
    if (input.runId !== undefined) item.runId = input.runId;
    const diagnosticId = input.diagnosticId ?? input.source?.diagnosticId;
    if (diagnosticId !== undefined) item.diagnosticId = diagnosticId;
    if (input.evidence !== undefined) item.evidence = input.evidence;
    this.#items.push(item);
    return item;
  }

  #addRootCause(
    code: DiagnosticRootCauseCode,
    summary: string,
    item: DiagnosticEvidenceItem,
    confidence: DiagnosticRootCause["confidence"] = "high",
  ): void {
    const existing = this.#rootCauses.get(code);
    if (existing !== undefined) {
      if (!existing.itemIds.includes(item.id)) {
        existing.itemIds.push(item.id);
      }
      if (existing.provider === undefined && item.provider !== undefined) {
        existing.provider = item.provider;
      }
      if (existing.commandId === undefined && item.commandId !== undefined) {
        existing.commandId = item.commandId;
      }
      if (existing.diagnosticId === undefined && item.diagnosticId !== undefined) {
        existing.diagnosticId = item.diagnosticId;
      }
      return;
    }

    const rootCause: DiagnosticRootCause = {
      code,
      confidence,
      summary,
      itemIds: [item.id],
    };
    if (item.provider !== undefined) rootCause.provider = item.provider;
    if (item.commandId !== undefined) rootCause.commandId = item.commandId;
    if (item.diagnosticId !== undefined) rootCause.diagnosticId = item.diagnosticId;
    this.#rootCauses.set(code, rootCause);
  }

  #classifyAndAddRootCause(
    error: EvidenceErrorSource | undefined,
    item: DiagnosticEvidenceItem,
    context: "provider" | "command" | "event" | "error" | "observer",
  ): void {
    const rootCause = classifyCode(error?.code ?? item.code, error?.message ?? item.message);
    if (rootCause !== undefined) {
      this.#addRootCause(rootCause.code, rootCause.summary, item);
      return;
    }
    if (context === "provider") {
      this.#addRootCause("PROVIDER_UNAVAILABLE", "A provider reported degraded health.", item);
      return;
    }
    if (context === "command" || context === "event" || context === "error") {
      this.#addRootCause("COMMAND_FAILED", "A command failed and needs diagnostic review.", item);
    }
  }

  #addRowQuestions(row: DiagnosticSnapshot["snapshot"]["rows"][number], itemId: string): void {
    const providerParts = [`worktree source ${row.worktree.source}`];
    if (row.terminal !== undefined) {
      providerParts.push(`terminal provider ${row.terminal.provider}`);
    }
    if (row.agent !== undefined) {
      providerParts.push(`harness ${row.agent.harness}`);
    }
    this.#questions.push({
      id: `row-${row.id}-provider`,
      question: `Which providers explain row ${row.id}?`,
      answer: `Row ${row.id} uses ${providerParts.join(", ")}.`,
      itemIds: [itemId],
    });

    if (row.agent?.runId !== undefined) {
      this.#questions.push({
        id: `row-${row.id}-agent-run`,
        question: `Which agent run backs row ${row.id}?`,
        answer: `Row ${row.id} uses ${row.agent.harness} run ${row.agent.runId}.`,
        itemIds: [itemId],
      });
    }
  }

  #status(
    rootCauseCodes: readonly DiagnosticRootCauseCode[],
  ): DiagnosticEvidenceIndex["summary"]["status"] {
    if (rootCauseCodes.includes("INVALID_CONFIG")) {
      return "unavailable";
    }
    if (
      rootCauseCodes.length > 0 ||
      this.#snapshot.observerHealth.status !== "healthy" ||
      !this.#snapshot.snapshot.observer.healthy
    ) {
      return "degraded";
    }
    return "healthy";
  }
}

type AddItemInput = {
  id: string;
  category: DiagnosticEvidenceItem["category"];
  severity: DiagnosticEvidenceItem["severity"];
  code?: string | undefined;
  message: string;
  source?: EvidenceErrorSource | undefined;
  provider?: string | undefined;
  commandId?: string | undefined;
  traceId?: string | undefined;
  spanId?: string | undefined;
  projectId?: string | undefined;
  worktreeId?: string | undefined;
  sessionId?: string | undefined;
  targetId?: string | undefined;
  runId?: string | undefined;
  diagnosticId?: string | undefined;
  evidence?: Record<string, unknown> | undefined;
};

function classifyCode(
  code: string | undefined,
  message: string,
): { code: DiagnosticRootCauseCode; summary: string } | undefined {
  if (code === undefined) {
    return undefined;
  }
  if (code.startsWith("CONFIG_")) {
    return { code: "INVALID_CONFIG", summary: "The config could not be loaded or validated." };
  }
  if (code === "WORKTRUNK_UNAVAILABLE") {
    return {
      code: "MISSING_WORKTRUNK_BINARY",
      summary: "Worktrunk binary is missing or not executable.",
    };
  }
  if (code === "WORKTRUNK_BRANCH_EXISTS") {
    return {
      code: "WORKTRUNK_BRANCH_EXISTS",
      summary: "Worktrunk could not create the worktree because the branch already exists.",
    };
  }
  if (code === "WORKTRUNK_WORKTREE_EXISTS") {
    return {
      code: "WORKTRUNK_WORKTREE_EXISTS",
      summary: "Worktrunk could not create the worktree because the worktree already exists.",
    };
  }
  if (
    code === "TERMINAL_TARGET_STALE" ||
    code === "TERMINAL_TARGET_MISSING" ||
    code === "TERMINAL_TARGET_NOT_FOUND"
  ) {
    return {
      code: "STALE_TERMINAL_TARGET",
      summary: "The terminal target no longer exists or cannot be focused.",
    };
  }
  if (code === "PROVIDER_TIMEOUT") {
    return { code: "PROVIDER_TIMEOUT", summary: "A provider operation timed out." };
  }
  if (code.includes("UNEXPECTED_EXIT") || message.toLowerCase().includes("unexpectedly")) {
    return {
      code: "HARNESS_UNEXPECTED_EXIT",
      summary: "Harness process exited unexpectedly.",
    };
  }
  if (code.startsWith("PERSISTENCE_") || code.startsWith("SQLITE_")) {
    return { code: "SQLITE_WRITE_FAILURE", summary: "Observer SQLite writes are failing." };
  }
  if (code.startsWith("HOOK_") || code === "OBSERVER_START_FAILED") {
    return { code: "HOOK_SPOOL_FALLBACK", summary: "Hook delivery fell back to local spool." };
  }
  if (code === "COMMAND_FAILED" || code === "COMMAND_EXECUTION_FAILED") {
    return { code: "COMMAND_FAILED", summary: "A command failed and needs diagnostic review." };
  }
  return undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function logAttributeCode(attributes: Record<string, unknown> | undefined): string | undefined {
  const code = attributes?.code;
  return typeof code === "string" ? code : undefined;
}
