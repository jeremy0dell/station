import type {
  ClientFeatureFlags,
  HarnessCapabilities,
  HarnessRunObservation,
  ProviderHealth,
  ProviderProjectConfig,
  SessionGroupView,
  SessionRecoveryHandle,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { buildStationSnapshot } from "../../../src/reconcile/graph/build";
import type {
  ObserverSessionMetadata,
  ObserverTurnReadiness,
  ObserverWorktreeDisplayTitle,
} from "../../../src/reconcile/graph/evidence";

export const generatedAt = "2026-05-20T12:00:00.000Z";
export const observerStartedAt = "2026-05-20T11:55:00.000Z";

const observer = {
  pid: 4242,
  startedAt: observerStartedAt,
  version: "0.0.0",
};

export const worktreeProviderHealth: ProviderHealth = {
  provider: "fake-worktree",
  providerType: "worktree",
  status: "healthy",
  lastCheckedAt: generatedAt,
  capabilities: {
    canList: true,
    canCreate: true,
    canRemove: true,
  },
};

export const projects: ProviderProjectConfig[] = [
  {
    id: "web",
    label: "web",
    root: "/tmp/station/web",
    defaults: {
      harness: "fake-harness",
      terminal: "fake-terminal",
      layout: "agent-shell",
    },
    worktrunk: {
      enabled: true,
    },
  },
  {
    id: "api",
    label: "api",
    root: "/tmp/station/api",
    defaults: {
      harness: "fake-harness",
      terminal: "fake-terminal",
      layout: "agent-shell",
    },
    worktrunk: {
      enabled: true,
    },
  },
];

export function worktree(
  id: string,
  projectId: string,
  branch: string,
  providerData?: unknown,
): WorktreeObservation {
  return {
    id,
    provider: "fake-worktree",
    projectId,
    branch,
    path: `/tmp/station/${projectId}/${branch.replaceAll("/", "-")}`,
    state: "exists",
    source: "worktrunk",
    dirty: false,
    confidence: "high",
    reason: "Fixture worktree.",
    observedAt: generatedAt,
    ...(providerData === undefined ? {} : { providerData }),
  };
}

export function terminal(
  id: string,
  worktreeId: string,
  harnessRunId: string,
  state: TerminalTargetObservation["state"] = "open",
): TerminalTargetObservation {
  return {
    id,
    provider: "fake-terminal",
    projectId: worktreeId.startsWith("wt_api") ? "api" : "web",
    worktreeId,
    sessionId: `ses_${worktreeId}`,
    harnessRunId,
    state,
    confidence: state === "unknown" ? "low" : "high",
    reason: state === "unknown" ? "Terminal identity was uncertain." : "Fixture terminal.",
    observedAt: generatedAt,
    providerData: {
      paneId: `%${id}`,
    },
  };
}

export function harness(
  id: string,
  worktreeId: string,
  state: HarnessRunObservation["status"]["value"],
  reason = `Harness is ${state}.`,
): HarnessRunObservation {
  return harnessRun(id, worktreeId, state, reason);
}

export function harnessRun(
  id: string,
  worktreeId: string,
  state: HarnessRunObservation["status"]["value"],
  reason = `Harness is ${state}.`,
): HarnessRunObservation {
  return {
    id,
    provider: "fake-harness",
    projectId: worktreeId.startsWith("wt_api") ? "api" : "web",
    worktreeId,
    sessionId: `ses_${worktreeId}`,
    pid: state === "exited" ? undefined : 5000,
    status: {
      value: state,
      confidence: state === "unknown" ? "low" : "high",
      reason,
      source: "harness_process",
      updatedAt: generatedAt,
    },
    observedAt: generatedAt,
    providerData: {
      rawStatus: state,
    },
  };
}

export function build(overrides: {
  projects?: ProviderProjectConfig[];
  worktrees?: WorktreeObservation[];
  terminals?: TerminalTargetObservation[];
  harnessRuns?: HarnessRunObservation[];
  sessionMetadata?: ObserverSessionMetadata[];
  worktreeDisplayTitles?: ObserverWorktreeDisplayTitle[];
  turnReadiness?: ObserverTurnReadiness[];
  providerHealth?: Record<string, ProviderHealth>;
  recoveryHandles?: SessionRecoveryHandle[];
  harnessCapabilities?: Record<string, HarnessCapabilities>;
  featureFlags?: ClientFeatureFlags;
}) {
  return buildStationSnapshot({
    generatedAt,
    observer,
    projects: overrides.projects ?? projects,
    worktreeProviderId: "fake-worktree",
    providerHealth: overrides.providerHealth ?? {
      "fake-worktree": worktreeProviderHealth,
    },
    worktrees: overrides.worktrees ?? [],
    terminalTargets: overrides.terminals ?? [],
    harnessRuns: overrides.harnessRuns ?? [],
    sessionMetadata: overrides.sessionMetadata ?? [],
    worktreeDisplayTitles: overrides.worktreeDisplayTitles ?? [],
    turnReadiness: overrides.turnReadiness ?? [],
    recoveryHandles: overrides.recoveryHandles ?? [],
    harnessCapabilities: overrides.harnessCapabilities ?? {},
    ...(overrides.featureFlags === undefined ? {} : { featureFlags: overrides.featureFlags }),
  });
}

export const resumableHarnessCapabilities: HarnessCapabilities = {
  canLaunch: true,
  canDiscoverRuns: true,
  canEmitEvents: true,
  canReceivePrompt: false,
  canResume: true,
  canStop: true,
  canRunNonInteractive: true,
  canExposeApprovalState: false,
  supportsModifiedEnterSoftNewline: false,
};

export const recoveryFeatureFlags: ClientFeatureFlags = {
  revision: "recovery-enabled",
  flags: { sessionResumeAgent: true },
};

export function recoveryHandle(
  worktree: WorktreeObservation,
  overrides: Partial<SessionRecoveryHandle> = {},
): SessionRecoveryHandle {
  return {
    id: "rec_graph",
    provider: "fake-harness",
    projectId: worktree.projectId,
    worktreeId: worktree.id,
    sessionId: `ses_${worktree.id}`,
    target: { kind: "native-session", id: "native_graph" },
    cwd: worktree.path,
    observedAt: generatedAt,
    lastSeenAt: generatedAt,
    ...overrides,
  };
}

export function recoverySession(
  worktree: WorktreeObservation,
  overrides: Partial<ObserverSessionMetadata> = {},
): ObserverSessionMetadata {
  return {
    id: `ses_${worktree.id}`,
    projectId: worktree.projectId,
    worktreeId: worktree.id,
    lifecycle: "open",
    harness: "fake-harness",
    createdAt: generatedAt,
    lastSeenAt: generatedAt,
    ...overrides,
  };
}

export const projectedAt = "2026-05-20T12:00:01.000Z";

export function preparedProjectionFixture() {
  const observed = worktree("wt_web_projected", "web", "projected");
  observed.registrationIdentity = "registration:projected";
  const snapshot = build({ worktrees: [observed] });
  const session: ObserverSessionMetadata = {
    id: "ses_web_projected",
    projectId: "web",
    worktreeId: observed.id,
    lifecycle: "open",
    title: "Projected launch",
    harness: "fake-harness",
    terminalProvider: "managed-test",
    createdAt: generatedAt,
    lastSeenAt: generatedAt,
  };
  const harnessBinding = {
    role: "main-agent",
    harnessProvider: "fake-harness",
    worktreePath: observed.path,
  } satisfies NonNullable<TerminalTargetObservation["harnessBinding"]>;
  const target: TerminalTargetObservation & { harnessBinding: typeof harnessBinding } = {
    id: "managed://wt_web_projected",
    provider: "managed-test",
    projectId: "web",
    worktreeId: observed.id,
    sessionId: session.id,
    state: "open",
    cwd: observed.path,
    confidence: "high",
    reason: "Exact managed launch binding.",
    observedAt: projectedAt,
    harnessBinding,
  };
  const group: SessionGroupView = {
    id: "grp_projected",
    projectId: "web",
    name: "Projected",
    sessionIds: [session.id],
    version: 2,
    createdAt: generatedAt,
    updatedAt: projectedAt,
  };
  const input = {
    snapshot,
    projects,
    project: projects[0],
    worktreeProviderId: "fake-worktree",
    worktree: observed,
    terminalProviderId: "managed-test",
    terminalTargetId: target.id,
    terminalTarget: target,
    harnessProviderId: "fake-harness",
    session,
    sessionGroups: [group],
    harnessCapabilities: { "fake-harness": resumableHarnessCapabilities },
    terminalCapabilities: { canFocusTarget: false, canCloseTarget: false },
    projectedAt,
  };
  return { observed, snapshot, session, target, group, input };
}
