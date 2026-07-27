import type { LogRecord, RetentionPolicy } from "@station/contracts";
import type {
  DiagnosticEvidenceSource,
  DiagnosticHookSpoolEvidence,
  DiagnosticLocalStateEvidence,
  DiagnosticRecentLogEvidence,
} from "../../src/diagnostics/evidenceSource.js";

const timestamp = "2026-05-20T12:00:00.000Z";

export class FakeDiagnosticEvidenceSource implements DiagnosticEvidenceSource {
  readonly scanLocalStateCalls: RetentionPolicy[] = [];
  readonly readRecentLogsCalls: number[] = [];
  summarizeHookSpoolCalls = 0;

  localStateResult: DiagnosticLocalStateEvidence;
  recentLogsResult: DiagnosticRecentLogEvidence;
  hookSpoolResult: DiagnosticHookSpoolEvidence | undefined;

  scanLocalStateFailure: unknown;
  readRecentLogsFailure: unknown;
  summarizeHookSpoolFailure: unknown;

  constructor(
    options: {
      localState?: DiagnosticLocalStateEvidence;
      recentLogs?: DiagnosticRecentLogEvidence;
      hookSpool?: DiagnosticHookSpoolEvidence | undefined;
    } = {},
  ) {
    this.localStateResult = options.localState ?? memoryLocalStateEvidence();
    this.recentLogsResult = options.recentLogs ?? memoryRecentLogEvidence();
    this.hookSpoolResult = "hookSpool" in options ? options.hookSpool : memoryHookSpoolEvidence();
  }

  async scanLocalState(retention: RetentionPolicy): Promise<DiagnosticLocalStateEvidence> {
    this.scanLocalStateCalls.push(retention);
    if (this.scanLocalStateFailure !== undefined) {
      throw this.scanLocalStateFailure;
    }
    return this.localStateResult;
  }

  async readRecentLogs(maxRecords: number): Promise<DiagnosticRecentLogEvidence> {
    this.readRecentLogsCalls.push(maxRecords);
    if (this.readRecentLogsFailure !== undefined) {
      throw this.readRecentLogsFailure;
    }
    return this.recentLogsResult;
  }

  async summarizeHookSpool(): Promise<DiagnosticHookSpoolEvidence | undefined> {
    this.summarizeHookSpoolCalls += 1;
    if (this.summarizeHookSpoolFailure !== undefined) {
      throw this.summarizeHookSpoolFailure;
    }
    return this.hookSpoolResult;
  }
}

export function memoryLocalStateEvidence(): DiagnosticLocalStateEvidence {
  return {
    usage: {
      stateDir: "memory://state",
      totalBytes: 48,
      limitBytes: 1024,
      overLimit: false,
      entries: [
        {
          kind: "logs",
          path: "queue://logs",
          sizeBytes: 32,
          fileCount: 2,
          overLimit: false,
        },
        {
          kind: "hook_spool",
          path: "urn:station:hook-spool",
          sizeBytes: 16,
          fileCount: 1,
          overLimit: false,
        },
      ],
    },
    diagnosticsDir: "memory://diagnostics",
    socketPath: "memory://observer-socket",
  };
}

export function memoryRecentLogEvidence(
  records: LogRecord[] = [
    {
      timestamp,
      level: "info",
      component: "observer",
      message: "Memory diagnostic evidence.",
    },
  ],
): DiagnosticRecentLogEvidence {
  return {
    paths: ["queue://observer-log", "queue://hook-log"],
    records,
  };
}

export function memoryHookSpoolEvidence(): DiagnosticHookSpoolEvidence {
  return {
    path: "urn:station:hook-spool",
    pending: 1,
    oldestCreatedAt: timestamp,
    newestCreatedAt: timestamp,
  };
}
