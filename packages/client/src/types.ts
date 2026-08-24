import type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
  CommandId,
  CommandReceipt,
  SafeError,
  StationCommand,
  StationCommandResult,
  StationEvent,
  StationSnapshot,
  WorktreeCancelRemovalParams,
  WorktreeCancelRemovalResult,
  WorktreePrepareRemovalParams,
  WorktreePrepareRemovalResult,
} from "@station/contracts";

export type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
} from "@station/contracts";

export type StationClientCommandCompletion =
  | {
      status: "succeeded";
      commandId: CommandId;
      result?: StationCommandResult;
    }
  | {
      status: "failed";
      commandId: CommandId;
      error: SafeError;
    };

/**
 * App-facing observer API with timeout and safe-error normalization applied.
 * Distinct from protocol's `ObserverClient`, which is the raw socket transport.
 */
export type ObserverService = {
  loadSnapshot(): Promise<StationSnapshot>;
  subscribeEvents(): AsyncIterable<StationEvent>;
  dispatch(command: StationCommand): Promise<CommandReceipt>;
  waitForCommandCompletion(commandId: CommandId): Promise<StationClientCommandCompletion>;
  reconcile(reason?: string): Promise<StationSnapshot>;
  /**
   * Ask the observer to mint a STATION identity for an externally-hosted (e.g.
   * Station-owned) primary agent and return its launch plan. A supplied title
   * applies only when preparation mints a fresh session. Does not spawn.
   */
  prepareExternalLaunch(
    params: AgentPrepareExternalLaunchParams,
  ): Promise<AgentPrepareExternalLaunchResult>;
  /** Report that an externally-hosted agent's process exited. */
  reportExternalExit(params: AgentReportExternalExitParams): Promise<AgentReportExternalExitResult>;
  /** Validate and reserve one worktree while native PTYs settle. */
  prepareWorktreeRemoval(
    params: WorktreePrepareRemovalParams,
  ): Promise<WorktreePrepareRemovalResult>;
  /** Release a reservation when native preparation fails before command dispatch. */
  cancelWorktreeRemoval(params: WorktreeCancelRemovalParams): Promise<WorktreeCancelRemovalResult>;
};

export type ClientNotice = {
  kind: "info" | "success" | "error";
  message: string;
  hint?: string;
  commandId?: string;
  traceId?: string;
  diagnosticId?: string;
};

export type ApplyStationEventResult = {
  snapshot: StationSnapshot;
  needsSnapshotRefresh: boolean;
  notices: ClientNotice[];
};

export type StationClientConnectionState =
  | { state: "idle" }
  | { state: "loading"; since: number }
  | { state: "connected"; since: number }
  | { state: "reconnecting"; since: number; lastError: SafeError }
  | { state: "displayOnly"; since: number; lastError: SafeError }
  | { state: "halted"; since: number; lastError: SafeError };

export type StationClientRuntimeState = {
  snapshot?: StationSnapshot;
  connection: StationClientConnectionState;
  inFlightRefresh: boolean;
};

/** Canonical snapshot and connection truth shared by Station client consumers. */
export type StationClientState = Pick<StationClientRuntimeState, "snapshot" | "connection">;

/**
 * Identity-preserving source for the client runtime's canonical state.
 * Implementations notify after swapping the state object and never copy snapshots.
 */
export interface StationClientStateSource {
  getState(): StationClientState;
  subscribe(listener: () => void): () => void;
}

export type StationClientRefreshOutcome =
  | { status: "loaded"; snapshot: StationSnapshot }
  | { status: "connectFailure"; error: SafeError }
  | { status: "failure"; error: SafeError };

/**
 * Bridge callbacks for apps that need per-event and per-refresh side effects
 * (toasts, local-operation reconciliation). Hooks fire synchronously after the
 * runtime swaps its own state and before listeners are notified. Managed
 * refreshes and service reconciliation fire refresh hooks; service snapshot
 * loads do not.
 */
export type StationClientRuntimeHooks = {
  onEvent?(event: StationEvent, application: ApplyStationEventResult | undefined): void;
  onSubscriptionError?(
    error: SafeError,
    info: { isConnectError: boolean; alreadyReported: boolean; willRetry: boolean },
  ): void;
  onRefreshSettled?(outcome: StationClientRefreshOutcome): void;
};

/**
 * Reconnect delays grow exponentially with jitter from `initialDelayMs`
 * (default 100) up to a hard `maxDelayMs` cap (default 5000), resetting after
 * a successful resubscribe.
 */
export type StationClientReconnectOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
};

type StationClientRuntimeSharedOptions = {
  initialSnapshot?: StationSnapshot;
  requestTimeoutMs?: number;
  commandWaitTimeoutMs?: number;
  reconcileTimeoutMs?: number;
  clientLabel?: string;
  reconnect?: StationClientReconnectOptions;
  hooks?: StationClientRuntimeHooks;
};

type StationClientRuntimeServiceOptions = {
  /** Injected service boundary for tests and composed clients that already own transport setup. */
  service: ObserverService;
  socketPath?: never;
  expectedBuildVersion?: never;
};

type StationClientRuntimeSocketOptions = {
  service?: never;
  socketPath: string;
  /** Exact Observer selector already accepted before opening this socket-backed runtime. */
  expectedBuildVersion: string;
};

export type StationClientRuntimeOptions = StationClientRuntimeSharedOptions &
  (StationClientRuntimeServiceOptions | StationClientRuntimeSocketOptions);

/**
 * One live client projection and the convergence-safe service that mutates it.
 * Snapshot loads and reconciliation commit to runtime state before resolving.
 */
export type StationClientRuntime = {
  service: ObserverService;
  start(): void;
  stop(): Promise<void>;
  getState(): StationClientRuntimeState;
  subscribe(listener: () => void): () => void;
};
