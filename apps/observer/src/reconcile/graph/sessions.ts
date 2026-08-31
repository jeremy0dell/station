import type {
  HarnessCapabilities,
  HarnessRunObservation,
  ProviderProjectConfig,
  SessionView,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { harnessRunCanActivateSession, terminalCanActivateSession } from "../sessionActivation.js";
import type { ObserverSessionMetadata } from "./evidence.js";
import { terminalAttachment } from "./worktreeRows.js";

const emptyHarnessCapabilities: HarnessCapabilities = {
  canLaunch: false,
  canDiscoverRuns: false,
  canEmitEvents: false,
  canReceivePrompt: false,
  canResume: false,
  canStop: false,
  canRunNonInteractive: false,
  canExposeApprovalState: false,
  supportsModifiedEnterSoftNewline: false,
};

export type BuildSessionInput = {
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  title: string;
  terminal?: TerminalTargetObservation;
  harnessRun?: HarnessRunObservation;
  harnessCapabilities: Record<string, HarnessCapabilities>;
  sessionMetadataById: ReadonlyMap<string, ObserverSessionMetadata>;
  retainedSession?: ObserverSessionMetadata;
  terminalCapabilities?: Record<string, boolean>;
};

export function buildSessions(input: BuildSessionInput): SessionView[] {
  const sessions: SessionView[] = [];
  const stationSession = buildStationSession(input);
  if (stationSession !== undefined) sessions.push(stationSession);
  const externalSession = buildExternalSession(input);
  if (externalSession !== undefined) sessions.push(externalSession);
  return sessions;
}

export function buildStationSession(input: BuildSessionInput): SessionView | undefined {
  const identity = stationSessionIdentity(input);
  if (identity === undefined) return undefined;
  const run = identity.harnessRun;
  const harnessProvider = run?.provider ?? identity.metadata?.harness;
  if (harnessProvider === undefined) return undefined;
  const terminal = terminalForStationSession({
    terminal: input.terminal,
    sessionId: identity.id,
    sessionRunId: identity.harnessRun?.id,
    observedOtherRunId: identity.harnessRun === undefined ? input.harnessRun?.id : undefined,
  });
  const status =
    identity.harnessRun?.status ??
    retainedSessionStatus(identity.metadata, input.worktree.observedAt);
  const createdAt = identity.metadata?.createdAt ?? run?.observedAt ?? terminal?.observedAt;
  if (createdAt === undefined) return undefined;

  return sessionView({
    id: identity.id,
    origin: "station",
    input,
    harnessProvider,
    status,
    createdAt,
    title: input.title,
    ...(identity.harnessRun === undefined ? {} : { harnessRun: identity.harnessRun }),
    ...(terminal === undefined ? {} : { terminal }),
  });
}

function buildExternalSession(input: BuildSessionInput): SessionView | undefined {
  const harnessRun = input.harnessRun;
  const run = harnessRun;
  if (
    harnessRun === undefined ||
    run === undefined ||
    run.sessionId !== undefined ||
    !externalRunRepresentsSession(harnessRun)
  ) {
    return undefined;
  }
  const terminal = terminalForExternalRun(input.terminal, run.id);
  return sessionView({
    id: run.id,
    origin: "external",
    input,
    harnessProvider: run.provider,
    harnessRun,
    status: harnessRun.status,
    createdAt: run.observedAt,
    title: input.title,
    ...(terminal === undefined ? {} : { terminal }),
  });
}

type StationSessionIdentity = {
  id: string;
  metadata?: ObserverSessionMetadata;
  harnessRun?: HarnessRunObservation;
};

function stationSessionIdentity(input: BuildSessionInput): StationSessionIdentity | undefined {
  const harnessRun = input.harnessRun;
  if (harnessRun?.sessionId !== undefined) {
    const runSessionId = harnessRun.sessionId;
    const metadata = input.sessionMetadataById.get(runSessionId);
    if (
      !sessionMetadataIsEnded(metadata) &&
      (metadata?.lifecycle === "open" ||
        harnessRunCanActivateSession({
          run: harnessRun,
          terminals: input.terminal === undefined ? [] : [input.terminal],
          runs: [harnessRun],
        }))
    ) {
      return {
        id: runSessionId,
        harnessRun,
        ...(metadata === undefined ? {} : { metadata }),
      };
    }
  }

  const terminalSessionId = input.terminal?.sessionId;
  if (
    terminalSessionId !== undefined &&
    input.terminal !== undefined &&
    terminalCanActivateSession({
      target: input.terminal,
      runs: input.harnessRun === undefined ? [] : [input.harnessRun],
    })
  ) {
    const metadata = input.sessionMetadataById.get(terminalSessionId);
    if (metadata !== undefined && !sessionMetadataIsEnded(metadata)) {
      return { id: metadata.id, metadata };
    }
  }

  const retained = input.retainedSession;
  return retained === undefined ? undefined : { id: retained.id, metadata: retained };
}

function sessionMetadataIsEnded(metadata: ObserverSessionMetadata | undefined): boolean {
  return metadata?.lifecycle === "ended" || metadata?.endedAt !== undefined;
}

function terminalForStationSession(input: {
  terminal: TerminalTargetObservation | undefined;
  sessionId: string;
  sessionRunId: string | undefined;
  observedOtherRunId: string | undefined;
}): TerminalTargetObservation | undefined {
  const { terminal } = input;
  if (terminal === undefined) return undefined;
  if (terminal.sessionId === undefined) {
    return input.sessionRunId !== undefined && terminal.harnessRunId === input.sessionRunId
      ? terminal
      : undefined;
  }
  if (terminal.sessionId !== input.sessionId) return undefined;
  if (terminal.harnessRunId === undefined) return terminal;
  if (input.sessionRunId !== undefined) {
    return terminal.harnessRunId === input.sessionRunId ? terminal : undefined;
  }
  return terminal.harnessRunId === input.observedOtherRunId ? undefined : terminal;
}

function terminalForExternalRun(
  terminal: TerminalTargetObservation | undefined,
  runId: string,
): TerminalTargetObservation | undefined {
  if (terminal?.sessionId !== undefined) return undefined;
  return terminal?.harnessRunId === runId ? terminal : undefined;
}

function sessionView(input: {
  id: string;
  origin: SessionView["origin"];
  input: BuildSessionInput;
  harnessProvider: string;
  harnessRun?: HarnessRunObservation;
  terminal?: TerminalTargetObservation;
  status: SessionView["status"];
  createdAt: string;
  title: string;
}): SessionView {
  const run = input.harnessRun;
  const harness: SessionView["harness"] = {
    provider: input.harnessProvider,
    mode: "unknown",
    capabilities:
      input.input.harnessCapabilities[input.harnessProvider] ?? emptyHarnessCapabilities,
  };
  if (run !== undefined) harness.runId = run.id;
  if (run?.pid !== undefined) harness.pid = run.pid;

  const session: SessionView = {
    id: input.id,
    origin: input.origin,
    projectId: input.input.project.id,
    worktreeId: input.input.worktree.id,
    createdAt: input.createdAt,
    updatedAt: input.status.updatedAt,
    harness,
    status: {
      value: input.status.value,
      confidence: input.status.confidence,
      reason: input.status.reason,
      source: input.status.source,
      updatedAt: input.status.updatedAt,
    },
    title: input.title,
    tags: [],
  };
  if (input.status.attention !== undefined) session.status.attention = input.status.attention;
  if (input.terminal !== undefined) {
    session.terminal = terminalAttachment(
      input.terminal,
      input.harnessRun,
      input.input.terminalCapabilities,
    );
  }
  return session;
}

function externalRunRepresentsSession(run: HarnessRunObservation): boolean {
  return (
    run.status.value !== "none" && run.status.value !== "unknown" && run.status.value !== "exited"
  );
}

function retainedSessionStatus(
  metadata: ObserverSessionMetadata | undefined,
  fallbackUpdatedAt: string,
): SessionView["status"] {
  const updatedAt = metadata?.lastSeenAt ?? fallbackUpdatedAt;
  return {
    value: "none",
    confidence: "low",
    reason: "No harness run is currently observed for this Station session.",
    source: "reconcile",
    updatedAt,
  };
}

export function newestRetainedSessionByWorktree(
  sessions: readonly ObserverSessionMetadata[],
): ReadonlyMap<string, ObserverSessionMetadata> {
  const retained = new Map<string, ObserverSessionMetadata>();
  for (const session of sessions) {
    if (
      session.lifecycle !== "open" ||
      session.endedAt !== undefined ||
      session.harness === undefined
    ) {
      continue;
    }
    const key = sessionWorktreeKey(session.projectId, session.worktreeId);
    const current = retained.get(key);
    if (current === undefined || compareSessionRecency(session, current) > 0) {
      retained.set(key, session);
    }
  }
  return retained;
}

export function sessionWorktreeKey(projectId: string, worktreeId: string): string {
  return JSON.stringify([projectId, worktreeId]);
}

function compareSessionRecency(
  left: ObserverSessionMetadata,
  right: ObserverSessionMetadata,
): number {
  return (
    Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt) ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
