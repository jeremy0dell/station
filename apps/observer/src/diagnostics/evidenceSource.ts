import type {
  DiagnosticSnapshot,
  LocalStateUsage,
  LogRecord,
  RetentionPolicy,
} from "@station/contracts";

export type DiagnosticLocalStateEvidence = {
  usage: LocalStateUsage;
  diagnosticsDir: string;
  socketPath?: string;
};

export type DiagnosticRecentLogEvidence = {
  paths: string[];
  records: LogRecord[];
};

export type DiagnosticHookSpoolEvidence = NonNullable<DiagnosticSnapshot["hookSpool"]>;

/**
 * DRIVEN PORT
 *
 * Supplies typed local diagnostic measurements and recent evidence while keeping
 * state, log, spool paths and filesystem representations outside diagnostic use cases.
 *
 * Evidence is read-only and diagnostic only; the port owns no persistence,
 * provider, core, or SQLite conversation.
 */
export interface DiagnosticEvidenceSource {
  scanLocalState(retention: RetentionPolicy): Promise<DiagnosticLocalStateEvidence>;
  readRecentLogs(maxRecords: number): Promise<DiagnosticRecentLogEvidence>;
  summarizeHookSpool(): Promise<DiagnosticHookSpoolEvidence | undefined>;
}
