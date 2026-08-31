import type {
  ClientFeatureFlags,
  HarnessCapabilities,
  HarnessRunObservation,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  SessionRecoveryHandle,
  SnapshotHarness,
  StationAlert,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";

export type ObserverGraphInput = {
  generatedAt: string;
  observer: {
    pid: number;
    startedAt: string;
    version: string;
    healthy?: boolean;
  };
  projects: ProviderProjectConfig[];
  worktreeProviderId: ProviderId;
  providerHealth: Record<string, ProviderHealth>;
  harnesses?: SnapshotHarness[];
  harnessCapabilities?: Record<string, HarnessCapabilities>;
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  harnessRuns: HarnessRunObservation[];
  sessionMetadata?: readonly ObserverSessionMetadata[];
  worktreeDisplayTitles?: readonly ObserverWorktreeDisplayTitle[];
  recoveryHandles?: readonly SessionRecoveryHandle[];
  turnReadiness?: readonly ObserverTurnReadiness[];
  alerts?: StationAlert[];
  featureFlags?: ClientFeatureFlags;
};

export type ObserverSessionMetadata = {
  id: string;
  projectId: string;
  worktreeId: string;
  lifecycle: "legacy" | "open" | "ended";
  title?: string;
  harness?: string;
  terminalProvider?: string;
  state?: string;
  createdAt: string;
  endedAt?: string;
  lastSeenAt: string;
};

export type ObserverWorktreeDisplayTitle = {
  projectId: string;
  worktreeId: string;
  title: string;
};

export type ObserverTurnReadiness = {
  sessionId: string;
  projectId: string;
  worktreeId: string;
  token: string;
  completedAt: string;
};
