import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readJsonlLog, scanLocalStateUsage } from "@station/observability";
import { safeErrorFromUnknown } from "@station/runtime";
import type {
  DiagnosticEvidenceSource,
  DiagnosticHookSpoolEvidence,
  DiagnosticLocalStateEvidence,
} from "./evidenceSource.js";

export type CreateLocalDiagnosticEvidenceSourceOptions = {
  stateDir: string;
  diagnosticsDir: string;
  logPaths: readonly string[];
  socketPath?: string;
  hookSpoolDir?: string;
};

/**
 * ADAPTER
 *
 * Captures resolved Observer runtime locations and translates local state,
 * structured JSONL logs, and hook-spool metadata into typed diagnostic evidence.
 *
 * Raw spool contents never cross the boundary, and local failures are normalized
 * without exposing raw records.
 */
export function createLocalDiagnosticEvidenceSource(
  options: CreateLocalDiagnosticEvidenceSourceOptions,
): DiagnosticEvidenceSource {
  const stateDir = options.stateDir;
  const diagnosticsDir = options.diagnosticsDir;
  const logPaths = [...options.logPaths];
  const socketPath = options.socketPath;
  const hookSpoolDir = options.hookSpoolDir;

  return {
    scanLocalState: async (retention) => {
      try {
        const usage = await scanLocalStateUsage(stateDir, retention);
        const evidence: DiagnosticLocalStateEvidence = {
          usage,
          diagnosticsDir,
        };
        if (socketPath !== undefined) {
          evidence.socketPath = socketPath;
        }
        return evidence;
      } catch (error) {
        throw localEvidenceError(error);
      }
    },
    readRecentLogs: async (maxRecords) => {
      try {
        const logs = await Promise.all(logPaths.map((path) => readJsonlLog(path, maxRecords)));
        return {
          paths: [...logPaths],
          records: logs.flat().slice(-maxRecords),
        };
      } catch (error) {
        throw localEvidenceError(error);
      }
    },
    summarizeHookSpool: async () => {
      if (hookSpoolDir === undefined) {
        return undefined;
      }
      try {
        return await summarizeHookSpool(hookSpoolDir);
      } catch (error) {
        throw localEvidenceError(error);
      }
    },
  };
}

async function summarizeHookSpool(path: string): Promise<DiagnosticHookSpoolEvidence> {
  const entries = await listFileStats(path);
  const created = entries.map((entry) => entry.mtime.toISOString()).sort();
  const summary: DiagnosticHookSpoolEvidence = {
    path,
    pending: entries.length,
  };
  const oldestCreatedAt = created[0];
  const newestCreatedAt = created.at(-1);
  if (oldestCreatedAt !== undefined) {
    summary.oldestCreatedAt = oldestCreatedAt;
  }
  if (newestCreatedAt !== undefined) {
    summary.newestCreatedAt = newestCreatedAt;
  }
  return summary;
}

async function listFileStats(path: string): Promise<Array<{ mtime: Date }>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    // Await inside the try so post-readdir file rotation remains best-effort.
    return await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const fileStat = await stat(join(path, entry.name));
          return { mtime: fileStat.mtime };
        }),
    );
  } catch {
    return [];
  }
}

function localEvidenceError(error: unknown) {
  return safeErrorFromUnknown(error, {
    tag: "DiagnosticEvidenceError",
    code: "LOCAL_DIAGNOSTIC_EVIDENCE_FAILED",
    message: "Local diagnostic evidence collection failed.",
  });
}
