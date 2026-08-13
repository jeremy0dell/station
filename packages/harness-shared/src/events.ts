import type { HarnessEventDiagnostics, HarnessEventReport } from "@station/contracts";

export type HarnessEventDiagnosticsInput = {
  payloadBytes?: number | null;
  compactedBytes?: number | null;
  compacted?: boolean;
  truncated?: boolean;
  omittedFieldNames?: string[];
};

export type HarnessEventCorrelation = {
  projectId?: string | undefined;
  sessionId?: string | undefined;
  worktreeId?: string | undefined;
  terminalTargetId?: string | undefined;
  harnessRunId?: string | undefined;
  nativeSessionId?: string | undefined;
  nativeSessionFile?: string | undefined;
  cwd?: string | undefined;
  pid?: number | undefined;
};

export function harnessEventDiagnostics(
  rawEventType: string,
  input: HarnessEventDiagnosticsInput | undefined,
): HarnessEventDiagnostics {
  const diagnostics: HarnessEventDiagnostics = { rawEventType };
  if (typeof input?.payloadBytes === "number") diagnostics.payloadBytes = input.payloadBytes;
  if (typeof input?.compactedBytes === "number") diagnostics.compactedBytes = input.compactedBytes;
  if (input?.compacted !== undefined) diagnostics.compacted = input.compacted;
  if (input?.truncated !== undefined) diagnostics.truncated = input.truncated;
  if (input?.omittedFieldNames !== undefined && input.omittedFieldNames.length > 0) {
    diagnostics.omittedFieldNames = input.omittedFieldNames;
  }
  return diagnostics;
}

export function reportCorrelation(
  input: HarnessEventCorrelation,
): HarnessEventReport["correlation"] {
  const correlation: NonNullable<HarnessEventReport["correlation"]> = {};
  if (input.harnessRunId !== undefined) correlation.harnessRunId = input.harnessRunId;
  if (input.sessionId !== undefined) correlation.sessionId = input.sessionId;
  if (input.worktreeId !== undefined) correlation.worktreeId = input.worktreeId;
  if (input.terminalTargetId !== undefined) correlation.terminalTargetId = input.terminalTargetId;
  if (input.projectId !== undefined) correlation.projectId = input.projectId;
  if (input.nativeSessionId !== undefined) correlation.nativeSessionId = input.nativeSessionId;
  if (input.nativeSessionFile !== undefined)
    correlation.nativeSessionFile = input.nativeSessionFile;
  if (input.cwd !== undefined) correlation.cwd = input.cwd;
  if (input.pid !== undefined) correlation.pid = input.pid;
  return Object.keys(correlation).length === 0 ? undefined : correlation;
}
